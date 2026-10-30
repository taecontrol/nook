import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { vectorizeIdLimits } from '../scripts/search-stand-ins.ts';
import {
  type MemoryFixture,
  memoryFixture,
  seedMemories,
} from './support/memory.ts';
import { forgetMemory, removalRows } from './support/memory-forget.ts';
import { type SearchRuntime, searchRuntime } from './support/search.ts';

let app: SearchRuntime;
let workerLogs: string[];
beforeEach(async () => {
  app = await searchRuntime();
  workerLogs = [];
  await app.setBindings(
    {
      LOCAL_OWNER: 'synthetic-owner',
      LOCAL_ORIGIN: app.origin,
      EMBEDDING_MODEL: model,
    },
    {
      outboundService: async (request) => {
        if (new URL(request.url).pathname !== '/run')
          return app.services.fetch(request);
        // Only the AI boundary synthesizes vectors: these corpora are larger
        // than the recorded fixtures, and recall is not what they prove.
        const [requested, input] = (await request.json()) as [
          string,
          { text: string[]; truncate_inputs?: boolean },
        ];
        app.services.embeddingCalls.push({ model: requested, ...input });
        if (app.services.failEmbedding)
          return new Response('Synthetic embedding failure.', { status: 503 });
        const data = input.text.map(() => [1, ...Array<number>(1023).fill(0)]);
        return Response.json({ data, shape: [data.length, 1024] });
      },
      handleRuntimeStdio(stdout, stderr) {
        for (const stream of [stdout, stderr])
          stream.on('data', (chunk) => workerLogs.push(chunk.toString()));
      },
    },
  );
});
afterEach(() => app?.close());

const model = '@cf/baai/bge-m3';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const at = (minutes: number) => new Date(Date.UTC(2030, 0, 1, 0, minutes));
const corpus = (n: number) =>
  Array.from({ length: n }, (_, i) => memoryFixture(i + 1));

// The state production reached before #90: every memory acknowledged and
// served by a vector, written without model identity unless one is given.
async function indexed(memories: MemoryFixture[], vectorModel?: string) {
  await seedMemories(app, memories);
  const db = await app.mf.getD1Database('DB');
  await db
    .prepare(`UPDATE memories SET embedding_marker=? || ':' || content_hash`)
    .bind(model)
    .run();
  app.services.upsert(
    memories.map((m) => ({
      id: m.id,
      values: [1, ...Array<number>(1023).fill(0)],
      metadata: {
        bucket: hash(m.bucket).slice(0, 32),
        contentHash: hash(m.content),
        ...(vectorModel ? { model: vectorModel } : {}),
      },
    })),
  );
  app.services.advance();
  app.services.resetCalls();
}
// Reads in the same batches production must use.
function vectors(ids: string[]) {
  const found = [];
  for (let i = 0; i < ids.length; i += vectorizeIdLimits.get)
    found.push(
      ...app.services.getByIds(ids.slice(i, i + vectorizeIdLimits.get)),
    );
  return found;
}
async function failures() {
  // Workerd may flush a line after the scheduled handler resolves.
  await new Promise((resolve) => setTimeout(resolve, 100));
  return workerLogs
    .join('')
    .split(/\r?\n/)
    .filter((line) => line.includes('memory-sync-failed'))
    .map((line) => JSON.parse(line.slice(line.indexOf('{'))));
}

it('#95: a model-less corpus larger than one Vectorize get is re-embedded within ceil(N/50) + 1 crons, fifty at a time', async () => {
  const memories = corpus(72);
  const ids = memories.map((m) => m.id);
  await indexed(memories);
  const db = await app.mf.getD1Database('DB');

  for (const minutes of [0, 5, 10]) {
    await app.scheduled(at(minutes));
    expect(
      app.services.inspections.flat().length,
      'Inspection stays bounded to one page per cron',
    ).toBeLessThanOrEqual(50);
    expect(
      app.services.embeddingCalls.flatMap((c) => c.text).length,
      'Repair stays bounded to one page per cron',
    ).toBeLessThanOrEqual(50);
    app.services.advance();
    app.services.resetCalls();
  }

  expect(vectors(ids).map((v) => [v.id, v.metadata?.model])).toEqual(
    ids.map((id) => [id, model]),
  );
  const { results } = await db
    .prepare(
      `SELECT count(*) AS n FROM memories WHERE embedding_marker=? || ':' || content_hash`,
    )
    .bind(model)
    .all<{ n: number }>();
  expect(results[0].n).toBe(72);
  expect(await failures()).toEqual([]);
});

it('#95: a sweep of more removals than one Vectorize get deletes every lingering vector', async () => {
  const memories = corpus(30);
  const ids = memories.map((m) => m.id);
  await indexed(memories, model);
  for (const id of ids) await forgetMemory(app, id);
  const [last] = (await removalRows(app)).slice(-1);
  const forgottenAt = Date.parse(last.forgotten_at);
  app.services.resetCalls();

  await app.scheduled(new Date(forgottenAt + 5 * 60_000));
  expect(app.services.deletions.flat().sort()).toEqual([...ids].sort());
  app.services.advance();
  expect(vectors(ids)).toEqual([]);
  await app.scheduled(new Date(forgottenAt + 35 * 60_000));
  expect(await removalRows(app)).toEqual([]);
  expect(await failures()).toEqual([]);
});

it.each([
  ['inspection', 'failInspection', 'Synthetic inspection failure.'],
  ['sweep', 'failDelete', 'Synthetic delete failure.'],
  ['embedding', 'failEmbedding', 'Synthetic embedding failure.'],
] as const)(
  '#95: a failed scheduled %s leaves a log record an operator can find',
  async (stage, failure, error) => {
    const [kept, forgotten, pending] = corpus(3);
    await indexed([kept, forgotten], model);
    await forgetMemory(app, forgotten.id);
    await seedMemories(app, [pending]);
    app.services[failure] = true;

    await app.scheduled(at(60 * 24 * 365));
    expect(await failures()).toContainEqual({
      event: 'memory-sync-failed',
      stage,
      error,
    });
  },
);
