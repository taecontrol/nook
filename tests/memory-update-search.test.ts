import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { searchMemories, spanishRelease } from './fixtures/search-corpus.ts';
import { deferred } from './support/machines.ts';
import {
  manyMemories,
  memoryClient,
  memoryFixture,
  memoryId,
  seedMemories,
} from './support/memory.ts';
import {
  httpSearch,
  indexMemories,
  type SearchRuntime,
  searchRuntime,
} from './support/search.ts';

let app: SearchRuntime;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const newContent = searchMemories[3].content;
beforeEach(async () => {
  app = await searchRuntime();
});
afterEach(() => app?.close());
it('E18: scheduled inspection invalidates a missing vector even when embedding repair fails', async () => {
  const settled = memoryFixture(20, { content: spanishRelease });
  await indexMemories(app, [settled]);
  app.services.clear();
  await seedMemories(app, [memoryFixture(23, { content: newContent })]);
  app.services.failEmbedding = true;
  await app.scheduled(new Date('2030-01-01T00:00:00Z'));
  expect(app.services.embeddingCalls).toHaveLength(1);
  expect(app.services.inspections).toEqual([[settled.id]]);
  expect(await marker()).toBeNull();
});
const client = () => memoryClient(app, '2026-07-28');
const update = (content = newContent, tags?: string[]) =>
  client().call('update', {
    id: memoryId(20),
    expectedVersion: 1,
    content,
    ...(tags ? { tags } : {}),
  });
async function marker(id = memoryId(20)) {
  return (
    await (
      await app.mf.getD1Database('DB')
    )
      .prepare('SELECT embedding_marker FROM memories WHERE id=?')
      .bind(id)
      .first()
  )?.embedding_marker;
}
async function integrity() {
  expect(
    await (await app.mf.getD1Database('DB'))
      .prepare(
        "INSERT INTO memories_fts(memories_fts,rank) VALUES ('integrity-check',1)",
      )
      .run(),
  ).toMatchObject({ success: true });
}
it('E16/E17/E19: after update returns, MCP and HTTP keyword/meaning never match or quote old content', async () => {
  await indexMemories(app, [
    memoryFixture(20, { content: spanishRelease, tags: ['deploy'] }),
  ]);
  let replacementUnavailable = true;
  await app.setBindings(
    {
      LOCAL_OWNER: 'synthetic-owner',
      LOCAL_ORIGIN: app.origin,
      EMBEDDING_MODEL: '@cf/baai/bge-m3',
    },
    {
      outboundService: async (request) => {
        if (new URL(request.url).pathname === '/run') {
          const [, input] = (await request.clone().json()) as [
            string,
            { text: string[] },
          ];
          if (input.text[0] === newContent && replacementUnavailable)
            return new Response('Synthetic replacement embedding unavailable', {
              status: 503,
            });
        }
        return app.services.fetch(request);
      },
    },
  );
  expect((await update(newContent, ['cli'])).structuredContent).toMatchObject({
    updated: true,
    version: 2,
  });
  for (const query of ['publicar', 'how do we deploy']) {
    const found = await httpSearch(app, query);
    expect(found.meaning).toBe('available');
    expect(found.results).toEqual([]);
    expect(
      (await client().call('search', { bucket: 'work/acme', query }))
        .structuredContent,
    ).toMatchObject({ results: [] });
  }
  const current = await httpSearch(app, 'pnpm verify');
  expect(current.results).toContainEqual(
    expect.objectContaining({
      id: memoryId(20),
      match: 'keyword',
      snippet: expect.stringContaining('pnpm'),
    }),
  );
  expect(
    (
      await client().call('search', {
        bucket: 'work/acme',
        query: 'pnpm verify',
        tags: ['deploy'],
      })
    ).structuredContent,
  ).toMatchObject({ results: [] });
  expect(JSON.stringify(current)).not.toContain('Para publicar');
  expect(app.services.queries.length).toBeGreaterThan(0);
  replacementUnavailable = false;
  await app.scheduled();
  app.services.advance();
  expect((await httpSearch(app, 'pnpm verify')).results).toContainEqual(
    expect.objectContaining({ id: memoryId(20), match: 'both' }),
  );
  await integrity();
});
it.each(['tags', 'model'] as const)(
  'inspection freshness: a concurrent %s change during getByIds preserves the replacement marker',
  async (change) => {
    await indexMemories(app, [memoryFixture(20, { content: spanishRelease })]);
    const values = app.services.run('@cf/baai/bge-m3', {
      text: [spanishRelease],
    }).data[0];
    app.services.upsert([
      {
        id: memoryId(20),
        values,
        metadata: {
          bucket: 'wrong',
          contentHash: hash(spanishRelease),
          model: '@cf/baai/bge-m3',
        },
      },
    ]);
    app.services.advance();
    await (await app.mf.getD1Database('DB'))
      .prepare(
        "UPDATE memories SET updated_at='2000-01-01T00:00:00.000Z' WHERE id=?",
      )
      .bind(memoryId(20))
      .run();
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
          if (new URL(request.url).pathname === '/getByIds') {
            arrived.resolve();
            await gate.promise;
          }
          return app.services.fetch(request);
        },
      },
    );
    const inspection = app.scheduled();
    try {
      await arrived.promise;
      const expected = `${change === 'tags' ? '@cf/baai/bge-m3' : 'replacement-model'}:${hash(spanishRelease)}`;
      if (change === 'tags')
        expect(
          (await update(spanishRelease, [])).structuredContent,
        ).toMatchObject({
          updated: true,
          version: 2,
        });
      else {
        // Represents another Worker's valid acknowledgement in real D1.
        // Hosted two-deployment integration remains the owner's E31 check.
        await (await app.mf.getD1Database('DB'))
          .prepare('UPDATE memories SET embedding_marker=? WHERE id=?')
          .bind(expected, memoryId(20))
          .run();
      }
      gate.resolve();
      await inspection;
      expect(await marker()).toBe(expected);
    } finally {
      gate.resolve();
      await inspection;
    }
  },
);
it('E18: rotating inspection visits a stale current marker amid a pending backlog within ceil(N/50) successful runs', async () => {
  const target = manyMemories[0];
  await indexMemories(app, [{ ...target, content: spanishRelease }]);
  expect(
    (
      await client().call('update', {
        id: target.id,
        expectedVersion: 1,
        content: target.content,
      })
    ).structuredContent,
  ).toMatchObject({ updated: true, version: 2 });
  await expect
    .poll(() => marker(target.id))
    .toBe(`@cf/baai/bge-m3:${hash(target.content)}`);
  app.services.advance();
  const backlog = [
    ...manyMemories.slice(1),
    ...manyMemories.slice(0, 11).map((memory, index) => ({
      ...memory,
      id: memoryId(500 + index),
      bucket: 'work/other',
    })),
  ];
  expect(backlog).toHaveLength(100);
  await seedMemories(app, backlog);
  const obsolete = app.services.run('@cf/baai/bge-m3', {
    text: [spanishRelease],
  }).data[0];
  app.services.upsert([
    {
      id: target.id,
      values: obsolete,
      metadata: {
        bucket: hash(target.bucket).slice(0, 32),
        contentHash: hash(spanishRelease),
        model: '@cf/baai/bge-m3',
      },
    },
  ]);
  app.services.advance();
  app.services.resetCalls();
  for (let index = 0; index < 3; index++) {
    await app.scheduled(new Date(Date.UTC(2030, 0, 1, 0, 15 + index * 5)));
    app.services.advance();
  }
  expect(app.services.inspections.flat()).toContain(target.id);
});
it('E17: a tags-only update keeps the marker and schedules no embedding', async () => {
  await indexMemories(app, [memoryFixture(20, { content: spanishRelease })]);
  const before = await marker();
  expect((await update(spanishRelease, [])).structuredContent).toMatchObject({
    updated: true,
    version: 2,
  });
  await app.scheduled();
  expect(app.services.embeddingCalls).toEqual([]);
  expect(app.services.upserts).toEqual([]);
  expect(await marker()).toBe(before);
  await integrity();
});
it('E18: a superseded embedding never writes an old marker after its upsert lands late', async () => {
  await seedMemories(app, [memoryFixture(20, { content: spanishRelease })]);
  const arrived = deferred();
  const gate = deferred();
  let held = false;
  await app.setBindings(
    {
      LOCAL_OWNER: 'synthetic-owner',
      LOCAL_ORIGIN: app.origin,
      EMBEDDING_MODEL: '@cf/baai/bge-m3',
    },
    {
      outboundService: async (request) => {
        if (!held && new URL(request.url).pathname === '/upsert') {
          held = true;
          arrived.resolve();
          await gate.promise;
        }
        return app.services.fetch(request);
      },
    },
  );
  const oldJob = app.scheduled();
  try {
    await arrived.promise;
    expect((await update()).structuredContent).toMatchObject({ updated: true });
    await expect
      .poll(() => marker())
      .toBe(`@cf/baai/bge-m3:${hash(newContent)}`);
    gate.resolve();
    await oldJob;
    expect(await marker()).toBeNull();
    await app.scheduled();
    expect(await marker()).toBe(`@cf/baai/bge-m3:${hash(newContent)}`);
  } finally {
    gate.resolve();
    await oldJob;
  }
});
it('E18: scheduled vector inspection converges without search within ceil(N/50) windows and keeps 50/32 budgets', async () => {
  const seeds = manyMemories.slice(0, 61);
  await seedMemories(app, seeds);
  await app.scheduled(new Date('2030-01-01T00:00:00Z'));
  app.services.advance();
  await app.scheduled(new Date('2030-01-01T00:05:00Z'));
  app.services.advance();
  const obsolete = app.services.run('@cf/baai/bge-m3', {
    text: [spanishRelease],
  }).data[0];
  // The current model and bucket leave the content hash as the only mismatch.
  app.services.upsert(
    seeds.map((m) => ({
      id: m.id,
      values: obsolete,
      metadata: {
        bucket: hash(m.bucket).slice(0, 32),
        contentHash: hash(spanishRelease),
        model: '@cf/baai/bge-m3',
      },
    })),
  );
  app.services.advance();
  app.services.resetCalls();
  for (let i = 0; i < 2; i++)
    await app.scheduled(new Date(Date.UTC(2030, 0, 1, 0, i * 5)));
  expect(new Set(app.services.inspections.flat())).toEqual(
    new Set(seeds.map((m) => m.id)),
  );
  expect(app.services.inspections.every((ids) => ids.length <= 50)).toBe(true);
  // Next marker repair may write at most 50 and each AI chunk at most 32.
  app.services.resetCalls();
  await app.scheduled(new Date('2030-01-01T00:10:00Z'));
  expect(
    app.services.embeddingCalls.reduce((n, c) => n + c.text.length, 0),
  ).toBeLessThanOrEqual(50);
  expect(app.services.embeddingCalls.every((c) => c.text.length <= 32)).toBe(
    true,
  );
  app.services.advance();
  await app.scheduled(new Date('2030-01-01T00:15:00Z'));
  app.services.advance();
  for (const m of seeds) {
    expect(await marker(m.id)).toBe(`@cf/baai/bge-m3:${hash(m.content)}`);
    expect(app.services.getByIds([m.id])[0].metadata?.contentHash).toBe(
      hash(m.content),
    );
  }
});
it('embedding freshness: after AI completes, id and hash filter superseded rows while preserving a same-content memory in another bucket', async () => {
  await seedMemories(app, [
    memoryFixture(20, { content: spanishRelease }),
    memoryFixture(21, { bucket: 'me', content: spanishRelease }),
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
        if (new URL(request.url).pathname === '/run') {
          const [, input] = (await request.clone().json()) as [
            string,
            { text: string[] },
          ];
          if (input.text[0] === newContent)
            return new Response('Synthetic replacement embedding unavailable', {
              status: 503,
            });
          arrived.resolve();
          await gate.promise;
        }
        return app.services.fetch(request);
      },
    },
  );
  const job = app.scheduled();
  try {
    await arrived.promise;
    expect((await update()).structuredContent).toMatchObject({
      updated: true,
      version: 2,
    });
    gate.resolve();
    await job;
    expect(app.services.upserts.flat().map((v) => v.id)).toEqual([
      memoryId(21),
    ]);
    expect(await marker()).toBeNull();
    expect(await marker(memoryId(21))).toBe(
      `@cf/baai/bge-m3:${hash(spanishRelease)}`,
    );
  } finally {
    gate.resolve();
    await job;
  }
});
it('E18: settle window, failed inspection, missing vectors and wrong bucket metadata obey marker semantics', async () => {
  await indexMemories(app, [memoryFixture(20, { content: spanishRelease })]);
  const db = await app.mf.getD1Database('DB');
  const scheduled = new Date('2030-01-01T00:00:00Z');
  await db
    .prepare('UPDATE memories SET updated_at=? WHERE id=?')
    .bind('2029-12-31T23:55:00.000Z', memoryId(20))
    .run();
  await app.scheduled(scheduled);
  expect(app.services.inspections).toEqual([]);
  await db
    .prepare('UPDATE memories SET updated_at=? WHERE id=?')
    .bind('2029-12-31T23:40:00.000Z', memoryId(20))
    .run();
  app.services.failInspection = true;
  await app.scheduled(scheduled);
  expect(await marker()).toBe(`@cf/baai/bge-m3:${hash(spanishRelease)}`);
  app.services.failInspection = false;
  const values = app.services.run('@cf/baai/bge-m3', { text: [spanishRelease] })
    .data[0];
  // The current model and content hash leave the bucket as the only mismatch.
  app.services.upsert([
    {
      id: memoryId(20),
      values,
      metadata: {
        contentHash: hash(spanishRelease),
        bucket: 'wrong',
        model: '@cf/baai/bge-m3',
      },
    },
  ]);
  app.services.advance();
  await app.scheduled(scheduled);
  expect(await marker()).toBeNull();
  await app.scheduled(scheduled);
  app.services.advance();
  expect(await marker()).toBe(`@cf/baai/bge-m3:${hash(spanishRelease)}`);
  app.services.clear();
  await app.scheduled(scheduled);
  expect(await marker()).toBeNull();
});
