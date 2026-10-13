import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { handlerForPrincipal } from '../apps/worker/src/index.ts';
import {
  memoryClient,
  memoryFixture,
  memoryId,
  memoryRuntime,
  seedMemories,
  seedMemoryMachine,
} from './support/memory.ts';
import { vaultCheckpoints } from './support/vault-checkpoints.ts';

let app: Awaited<ReturnType<typeof memoryRuntime>>;
beforeAll(async () => {
  app = await memoryRuntime();
  await seedMemories(app, [
    memoryFixture(1),
    memoryFixture(2, { bucket: 'personal', content: 'private history text' }),
  ]);
});
afterAll(() => app?.close());
it('E20/E21: existing memories have one exact version, grant denials are 404, and machine credentials cannot reach history', async () => {
  const response = await fetch(
    `${app.origin}/api/memories/${memoryId(1)}/versions`,
  );
  expect(response.status).toBe(200);
  const original = await (
    await fetch(`${app.origin}/api/memories/${memoryId(1)}`)
  ).json();
  expect(await response.json()).toMatchObject({
    versions: [
      {
        version: 1,
        content: original.content,
        tags: original.tags,
        provenance: original.provenance,
      },
    ],
    next: null,
  });
  const handler = handlerForPrincipal(
    'owner@nook.test',
    await app.mf.getD1Database('DB'),
    ['work/acme'],
  );
  for (const id of [memoryId(2), randomUUID(), 'malformed']) {
    const denied = await handler(
      new Request(`http://nook.test/api/memories/${id}/versions`),
    );
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain('private history text');
  }
  const machine = await seedMemoryMachine(app);
  await app.setBindings({});
  try {
    for (const path of [
      `/api/memories/${memoryId(1)}/versions`,
      `/api/machine/memories/${memoryId(1)}/versions`,
    ]) {
      const denied = await fetch(app.origin + path, {
        headers: { Authorization: `Bearer ${machine.token}` },
      });
      expect(denied.status).toBe(path.includes('/machine/') ? 404 : 401);
    }
  } finally {
    await app.setBindings({
      LOCAL_OWNER: 'synthetic-owner',
      LOCAL_ORIGIN: app.origin,
    });
  }
});
it('E15: every authorized outcome uses a bucket preflight plus one three-statement batch', async () => {
  const labels: string[] = [];
  const measured = await vaultCheckpoints(
    async (label) => {
      labels.push(label);
      return true;
    },
    undefined,
    false,
    { observeBatchSize: true },
  );
  try {
    await seedMemories(measured, [
      memoryFixture(1),
      memoryFixture(2, { content: 'Other current memory' }),
    ]);
    const client = memoryClient(measured, '2026-07-28');
    for (const [input, outcome] of [
      [
        { expectedVersion: 1, content: 'New content' },
        { updated: true, version: 2 },
      ],
      [
        { expectedVersion: 1, content: 'New content' },
        { updated: false, version: 2 },
      ],
      [{ expectedVersion: 1, content: 'Stale content' }, { isError: true }],
      [
        { expectedVersion: 2, content: 'Other current memory' },
        { isError: true },
      ],
    ] as const) {
      labels.length = 0;
      const result = await client.call('update', { id: memoryId(1), ...input });
      expect(result.structuredContent ?? result).toMatchObject(outcome);
      expect(labels).toEqual([
        '/statement',
        '/before-batch',
        '/batch-3',
        '/after-batch',
      ]);
    }
  } finally {
    await measured.close();
  }
});
