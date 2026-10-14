import { afterEach, beforeEach, expect, it } from 'vitest';
import { searchMemories, spanishRelease } from './fixtures/search-corpus.ts';
import { deferred } from './support/machines.ts';
import {
  memoryClient,
  memoryFixture,
  memoryId,
  seedMemories,
} from './support/memory.ts';
import { forgetMemory, removalRows } from './support/memory-forget.ts';
import {
  httpSearch,
  indexMemories,
  type SearchRuntime,
  searchRuntime,
} from './support/search.ts';

let app: SearchRuntime;
const id = memoryId(20);
beforeEach(async () => {
  app = await searchRuntime();
});
afterEach(() => app?.close());
async function forgotten() {
  await indexMemories(app, [memoryFixture(20, { content: spanishRelease })]);
  await forgetMemory(app, id);
  expect(app.services.d1Trips).toBe(2);
  expect(app.services.embeddingCalls).toEqual([]);
  expect(app.services.queries).toEqual([]);
  expect(app.services.upserts).toEqual([]);
  expect(app.services.inspections).toEqual([]);
  expect(app.services.deletions).toEqual([]);
  const [row] = await removalRows(app);
  return Date.parse(row.forgotten_at);
}
const sweep = (time: number) => app.scheduled(new Date(time));
it('E24: owner HTTP forget makes no native vector request', async () => {
  await indexMemories(app, [memoryFixture(20, { content: spanishRelease })]);
  const result = await fetch(
    `${app.origin}/api/memories/${id}?expectedVersion=1`,
    { method: 'DELETE' },
  );
  expect(result.status).toBe(204);
  expect(app.services.d1Trips).toBe(2);
  expect(app.services.embeddingCalls).toEqual([]);
  expect(app.services.queries).toEqual([]);
  expect(app.services.upserts).toEqual([]);
  expect(app.services.inspections).toEqual([]);
  expect(app.services.deletions).toEqual([]);
});
it.each(['HTTP', 'MCP'] as const)(
  'E2/E12: a %s keyword search held by meaning lookup cannot return a memory forgotten meanwhile',
  async (endpoint) => {
    await indexMemories(app, [
      memoryFixture(20, { content: searchMemories[3].content }),
    ]);
    const arrived = deferred();
    const gate = deferred();
    await app.setBindings(
      {
        LOCAL_OWNER: 'synthetic-owner',
        LOCAL_ORIGIN: app.origin,
        EMBEDDING_MODEL: '@cf/baai/bge-m3',
      },
      {
        outboundService: async (request) => {
          if (new URL(request.url).pathname === '/query') {
            arrived.resolve();
            await gate.promise;
          }
          return app.services.fetch(request);
        },
      },
    );
    const pending =
      endpoint === 'HTTP'
        ? httpSearch(app, 'pnpm verify')
        : memoryClient(app, '2026-07-28')
            .call('search', { bucket: 'work/acme', query: 'pnpm verify' })
            .then((result) => result.structuredContent);
    try {
      await arrived.promise;
      await forgetMemory(app, id);
      gate.resolve();
      const result = await pending;
      expect(result).toMatchObject({ results: [] });
      expect(JSON.stringify(result)).not.toContain('Required verification');
    } finally {
      gate.resolve();
      await pending;
    }
  },
);
it('E2/E13/E24: lingering meaning hits are invisible; bounded delete is confirmed only after thirty minutes', async () => {
  const at = await forgotten();
  expect((await httpSearch(app, 'how do we deploy')).results).toEqual([]);
  expect(
    (
      await memoryClient(app, '2026-07-28').call('search', {
        bucket: 'work/acme',
        query: 'how do we deploy',
      })
    ).structuredContent,
  ).toMatchObject({ results: [] });
  app.services.resetCalls();
  await sweep(at + 5 * 60_000);
  expect(app.services.deletions).toEqual([[id]]);
  // One select for removals + existing repair/inspection calls; sweep itself is bounded.
  expect(app.services.inspections).toEqual([[id]]);
  expect(app.services.d1Trips).toBe(3); // sweep select, repair select, live inspection count
  expect(await removalRows(app)).toHaveLength(1);
  app.services.advance();
  await sweep(at + 29 * 60_000);
  expect(await removalRows(app)).toHaveLength(1);
  expect(app.services.deletions).toEqual([[id]]);
  app.services.resetCalls();
  await sweep(at + 30 * 60_000);
  expect(app.services.deletions).toEqual([]);
  expect(app.services.d1Trips).toBe(4); // two sweep trips plus unchanged repair and live-inspection reads
  expect(await removalRows(app)).toEqual([]);
  expect(app.services.getByIds([id])).toEqual([]);
});
it('E10/E14: a missing removal migration fails only its sweep and embedding repair still runs', async () => {
  await (await app.mf.getD1Database('DB'))
    .prepare('DROP TABLE memory_vector_removals')
    .run();
  await seedMemories(app, [memoryFixture(20, { content: spanishRelease })]);
  await app.scheduled();
  expect(app.services.upserts.flat().map((vector) => vector.id)).toEqual([id]);
  app.services.advance();
  expect((await httpSearch(app, 'how do we deploy')).results).toContainEqual(
    expect.objectContaining({ id }),
  );
});
it.each(['failIndex', 'failInspection', 'failDelete'] as const)(
  'E14: %s retains the record until recovery; an embedding outage cannot block removal',
  async (failure) => {
    const at = await forgotten();
    app.services[failure] = true;
    await sweep(at + 30 * 60_000);
    expect(await removalRows(app)).toHaveLength(1);
    app.services[failure] = false;
    app.services.failEmbedding = true;
    await seedMemories(app, [memoryFixture(21, { content: spanishRelease })]);
    await sweep(at + 35 * 60_000);
    expect(await removalRows(app)).toHaveLength(1);
    app.services.advance();
    await sweep(at + 40 * 60_000);
    expect(await removalRows(app)).toEqual([]);
    expect(app.services.deletions.flat()).toContain(id);
  },
);
it.each(['waitUntil', 'scheduled'] as const)(
  'E15: a gated late %s upsert is swept again and settles only after thirty minutes',
  async (writer) => {
    const gate = deferred();
    const arrived = deferred();
    await app.setBindings(
      {
        LOCAL_OWNER: 'synthetic-owner',
        LOCAL_ORIGIN: app.origin,
        EMBEDDING_MODEL: '@cf/baai/bge-m3',
      },
      {
        outboundService: async (request) => {
          if (new URL(request.url).pathname === '/upsert') {
            arrived.resolve();
            await gate.promise;
          }
          return app.services.fetch(request);
        },
      },
    );
    let pending: Promise<unknown>;
    let target: string;
    if (writer === 'scheduled') {
      await seedMemories(app, [memoryFixture(20, { content: spanishRelease })]);
      pending = app.scheduled();
      target = id;
    } else {
      const remembered = await memoryClient(app, '2026-07-28').call(
        'remember',
        { bucket: 'work/acme', content: spanishRelease },
      );
      target = remembered.structuredContent?.id as string;
      expect(target).toBeTruthy();
      pending = Promise.resolve();
    }
    try {
      await arrived.promise;
      await forgetMemory(app, target);
      const at = Date.parse((await removalRows(app))[0].forgotten_at);
      await sweep(at + 5 * 60_000);
      expect(await removalRows(app)).toHaveLength(1);
      gate.resolve();
      await pending;
      await expect
        .poll(() => app.services.upserts.flat().some((v) => v.id === target))
        .toBe(true);
      app.services.advance();
      await sweep(at + 10 * 60_000);
      expect(app.services.deletions.flat()).toContain(target);
      app.services.advance();
      await sweep(at + 29 * 60_000);
      expect(await removalRows(app)).toHaveLength(1);
      await sweep(at + 30 * 60_000);
      expect(await removalRows(app)).toEqual([]);
    } finally {
      gate.resolve();
      await pending;
    }
  },
);
it('E8/E16: sixty removals are bounded to fifty, exclude live IDs, and leave a byte-identical new vector alone', async () => {
  const at = await forgotten();
  const db = await app.mf.getD1Database('DB');
  const result = await memoryClient(app, '2026-07-28').call('remember', {
    bucket: 'work/acme',
    content: spanishRelease,
  });
  const live = result.structuredContent?.id as string;
  expect(result.structuredContent).toMatchObject({ created: true });
  await expect
    .poll(() => app.services.upserts.flat().some((v) => v.id === live))
    .toBe(true);
  const values = app.services.run('@cf/baai/bge-m3', { text: [spanishRelease] })
    .data[0];
  for (let n = 100; n < 159; n++) {
    const target = memoryId(n);
    await db
      .prepare(
        'INSERT INTO memory_vector_removals(id,forgotten_at) VALUES (?,?)',
      )
      .bind(target, new Date(at).toISOString())
      .run();
    app.services.upsert([{ id: target, values }]);
  }
  await db
    .prepare('INSERT INTO memory_vector_removals(id,forgotten_at) VALUES (?,?)')
    .bind(live, new Date(at).toISOString())
    .run();
  app.services.advance();
  app.services.resetCalls();
  await sweep(at + 5 * 60_000);
  expect(app.services.deletions).toHaveLength(1);
  expect(app.services.deletions[0]).toHaveLength(50);
  expect(app.services.inspections.every((ids) => ids.length <= 50)).toBe(true);
  expect(app.services.deletions.flat()).not.toContain(live);
  app.services.advance();
  await sweep(at + 30 * 60_000);
  app.services.advance();
  await sweep(at + 35 * 60_000);
  app.services.advance();
  await sweep(at + 40 * 60_000);
  expect((await removalRows(app)).map((r) => r.id)).toEqual([live]);
  expect(app.services.getByIds([live])).toHaveLength(1);
});
