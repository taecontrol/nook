import { afterEach, expect, it, vi } from 'vitest';
import worker from '../apps/worker/src/index.ts';
import { memoryFixture, memoryId, seedMemories } from './support/memory.ts';
import {
  fileBucket,
  fileMemory,
  filePath,
  fileRows,
  seedFile,
  seedFileMemory,
} from './support/memory-files.ts';
import { vaultRuntime } from './support/vault.ts';

type Bindings = Parameters<typeof worker.fetch>[1];
let app: Awaited<ReturnType<typeof vaultRuntime>>;
afterEach(() => app?.close());

async function bindings(): Promise<Bindings> {
  return {
    ...app.bindings,
    DB: await app.mf.getD1Database('DB'),
    FILES: (await app.mf.getR2Bucket('FILES')) as unknown as Bindings['FILES'],
  };
}
function request(env: Bindings, path: string, init?: RequestInit) {
  return worker.fetch(new Request(app.origin + path, init), env);
}
function searchIndex() {
  const query = vi.fn(async () => ({ matches: [] }));
  return {
    query,
    binding: { query } as unknown as NonNullable<Bindings['MEMORY_INDEX']>,
  };
}

it('warm owner search uses replacement AI, index and model bindings', async () => {
  app = await vaultRuntime({ r2Buckets: ['FILES'] });
  await seedFileMemory(app);
  const ai = () => ({
    run: vi.fn(async () => ({ data: [Array(1024).fill(0)] })),
  });
  const firstAI = ai();
  const secondAI = ai();
  const firstIndex = searchIndex();
  const secondIndex = searchIndex();
  const env = {
    ...(await bindings()),
    AI: firstAI,
    MEMORY_INDEX: firstIndex.binding,
  };
  const search = async (next: Bindings) => {
    const response = await request(
      next,
      `/api/memories/search?bucket=${fileBucket}&q=attachment`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ meaning: 'available' });
  };
  await search(env);
  await search({ ...env });
  expect(firstAI.run).toHaveBeenCalledTimes(2);
  await search({ ...env, AI: secondAI });
  expect(secondAI.run).toHaveBeenCalledTimes(1);
  await search({ ...env, AI: secondAI, MEMORY_INDEX: secondIndex.binding });
  expect(secondIndex.query).toHaveBeenCalledTimes(1);
  await search({
    ...env,
    AI: secondAI,
    MEMORY_INDEX: secondIndex.binding,
    EMBEDDING_MODEL: 'synthetic-other-model',
  });
  expect(secondAI.run).toHaveBeenLastCalledWith('synthetic-other-model', {
    text: ['attachment'],
    truncate_inputs: true,
  });
});

it('warm owner forgetting deletes from the currently supplied file binding', async () => {
  app = await vaultRuntime({ r2Buckets: ['FILES', 'OTHER_FILES'] });
  await seedFileMemory(app);
  const id = memoryId(612);
  await seedMemories(app, [memoryFixture(612, { bucket: fileBucket })]);
  const first = await seedFile(app);
  const second = await seedFile(app, { id });
  const primary = await app.mf.getR2Bucket('FILES');
  const other = await app.mf.getR2Bucket('OTHER_FILES');
  await other.put(second.object_key, Buffer.from('seeded attachment'));
  const env = await bindings();
  expect(
    (
      await request(env, `/api/memories/${fileMemory}?expectedVersion=1`, {
        method: 'DELETE',
      })
    ).status,
  ).toBe(204);
  expect(await primary.head(first.object_key)).toBeNull();
  expect(
    (
      await request(
        { ...env, FILES: other as unknown as Bindings['FILES'] },
        `/api/memories/${id}?expectedVersion=1`,
        { method: 'DELETE' },
      )
    ).status,
  ).toBe(204);
  expect(await other.head(second.object_key)).toBeNull();
  expect(await primary.head(second.object_key)).not.toBeNull();
});

it('warm machine uploads use replacement file storage and publication clocks', async () => {
  app = await vaultRuntime({ r2Buckets: ['FILES', 'OTHER_FILES'] });
  const machine = await seedFileMemory(app);
  const primary = await app.mf.getR2Bucket('FILES');
  const other = await app.mf.getR2Bucket('OTHER_FILES');
  const env = { ...(await bindings()), FILE_CLOCK: { now: () => Date.now() } };
  const upload = (next: Bindings, name: string) =>
    request(next, filePath(fileMemory, name), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${machine.token}`,
        'Content-Type': 'application/pdf',
        'Content-Length': '1',
      },
      body: Buffer.from('a'),
    });
  expect((await upload(env, 'first.pdf')).status).toBe(200);
  const switched = { ...env, FILES: other as unknown as Bindings['FILES'] };
  expect((await upload(switched, 'second.pdf')).status).toBe(200);
  const second = (await fileRows(app)).find((row) => row.name === 'second.pdf');
  if (!second) throw new Error('The second upload must publish its reference.');
  expect(await primary.head(second.object_key)).toBeNull();
  expect(await other.head(second.object_key)).not.toBeNull();
  const expired = await upload(
    { ...switched, FILE_CLOCK: { now: () => Date.now() - 600_001 } },
    'expired.pdf',
  );
  expect(expired.status).toBe(503);
  expect(await expired.json()).toEqual({ _tag: 'ServiceUnavailable' });
  expect((await fileRows(app)).map((row) => row.name)).toEqual([
    'first.pdf',
    'second.pdf',
  ]);
});
