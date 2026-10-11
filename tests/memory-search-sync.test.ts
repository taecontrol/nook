import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { applyMigrations, migrationFiles } from '../scripts/lib/migrations.ts';
import {
  denseContent,
  largeContent,
  searchMemories,
  spanishRelease,
} from './fixtures/search-corpus.ts';
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
beforeEach(async () => {
  app = await searchRuntime();
});
afterEach(() => app?.close());
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const remembered = (content: string) =>
  memoryClient(app, '2026-07-28').call('remember', {
    bucket: 'work/acme',
    content,
  });
async function marker(id: string) {
  return (await (
    await app.mf.getD1Database('DB')
  )
    .prepare('SELECT embedding_marker FROM memories WHERE id=?')
    .bind(id)
    .first()) as { embedding_marker: string | null };
}
it('FTS consistency: deleting a canonical memory removes its external-content index entry', async () => {
  await seedMemories(app, [searchMemories[0]]);
  const db = await app.mf.getD1Database('DB');
  await db.prepare('DELETE FROM memories WHERE id=?').bind(memoryId(20)).run();
  app.services.failEmbedding = true;
  expect((await httpSearch(app, 'publicar')).results).toEqual([]);
  expect(
    await db
      .prepare(
        "INSERT INTO memories_fts(memories_fts,rank) VALUES ('integrity-check', 1)",
      )
      .run(),
  ).toMatchObject({ success: true });
});
it('E11/E16: keyword is immediate, vectors stay hidden until visible, and an identical retry never re-embeds', async () => {
  const result = await remembered(spanishRelease);
  expect(result.structuredContent).toMatchObject({ created: true });
  const id = result.structuredContent?.id as string;
  await expect
    .poll(async () => (await marker(id))?.embedding_marker)
    .toBe(`@cf/baai/bge-m3:${hash(spanishRelease)}`);
  expect(app.services.embeddingCalls).toHaveLength(1);
  expect(app.services.upserts).toHaveLength(1);
  expect(app.services.d1Trips).toBe(2);
  expect(
    (await httpSearch(app, 'publicar')).results.map((m) => m.id),
  ).toContain(id);
  await expect
    .poll(async () => (await marker(id))?.embedding_marker)
    .toBe(`@cf/baai/bge-m3:${hash(spanishRelease)}`);
  expect((await httpSearch(app, 'how do we deploy')).results).toEqual([]);
  app.services.advance();
  expect((await httpSearch(app, 'how do we deploy')).results).toContainEqual(
    expect.objectContaining({ id, match: 'meaning' }),
  );
  app.services.resetCalls();
  expect((await remembered(spanishRelease)).structuredContent).toMatchObject({
    created: false,
    id,
  });
  expect(app.services.embeddingCalls).toEqual([]);
  expect(app.services.upserts).toEqual([]);
  expect(app.services.d1Trips).toBe(1);
});
it('E12: post-write embedding failure preserves creation and keyword search; Cron repairs it without a command', async () => {
  app.services.failEmbedding = true;
  const result = await remembered(spanishRelease);
  expect(result.structuredContent).toMatchObject({ created: true });
  const id = result.structuredContent?.id as string;
  expect(
    (await httpSearch(app, 'publicar')).results.map((m) => m.id),
  ).toContain(id);
  expect((await marker(id)).embedding_marker).toBeNull();
  app.services.failEmbedding = false;
  await app.scheduled();
  app.services.advance();
  expect((await httpSearch(app, 'how do we deploy')).results).toContainEqual(
    expect.objectContaining({ id, match: 'meaning' }),
  );
});
it('E11: creation and keyword search finish while post-write embedding is still pending', async () => {
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
          const args = (await request.clone().json()) as [
            string,
            { text: string[] },
          ];
          if (args[1].text[0] === spanishRelease) {
            arrived.resolve();
            await gate.promise;
          }
        }
        return app.services.fetch(request);
      },
    },
  );
  let response: Awaited<ReturnType<typeof remembered>> | undefined;
  const pending = remembered(spanishRelease).then((result) => {
    response = result;
    return result;
  });
  try {
    await arrived.promise;
    await expect.poll(() => response?.structuredContent?.created).toBe(true);
    const id = response?.structuredContent?.id as string;
    expect((await httpSearch(app, 'publicar')).results).toContainEqual(
      expect.objectContaining({ id, match: 'keyword' }),
    );
    expect((await marker(id)).embedding_marker).toBeNull();
    expect(app.services.upserts).toEqual([]);
  } finally {
    gate.resolve();
    await pending;
  }
});
it('E12/E14: a failed scheduled upsert has a successful workerd outcome and leaves every marker pending', async () => {
  await seedMemories(app, searchMemories);
  app.services.failIndex = true;
  const outcome = await (await app.mf.getWorker()).scheduled({
    cron: '*/5 * * * *',
    scheduledTime: new Date(),
  });
  expect(outcome.outcome).toBe('ok');
  expect(app.services.upserts).toHaveLength(1);
  for (const row of searchMemories)
    expect((await marker(row.id)).embedding_marker).toBeNull();
});
it('E13: migration rebuilds populated current versions and Cron backfills at most fifty with the specified call budgets', async () => {
  const files = await migrationFiles('migrations');
  expect(files).toContain('0010_memory_search.sql');
  const db = await app.mf.getD1Database('DB');
  // Recreate the published previous schema inside this synthetic database.
  for (const name of [
    'memories_fts_version_insert',
    'memories_fts_current_update',
    'memories_fts_delete',
  ])
    await db.prepare(`DROP TRIGGER ${name}`).run();
  await db.prepare('DROP TABLE memories_fts').run();
  await db.prepare('DROP VIEW memory_current').run();
  await db.prepare('ALTER TABLE memories DROP COLUMN embedding_marker').run();
  await db
    .prepare("DELETE FROM d1_migrations WHERE name='0010_memory_search.sql'")
    .run();
  // The exact-content guard is preserved; use the existing unique volume fixtures.
  await seedMemories(app, manyMemories.slice(0, 61));
  await applyMigrations(db);
  expect((await httpSearch(app, 'deployment')).results).toHaveLength(20);
  app.services.failEmbedding = true;
  for (let i = 0; i < 61; i++)
    expect((await httpSearch(app, `note ${i}`)).results).toContainEqual(
      expect.objectContaining({ id: manyMemories[i].id, match: 'keyword' }),
    );
  app.services.failEmbedding = false;
  app.services.resetCalls();
  await app.scheduled();
  expect(app.services.embeddingCalls).toHaveLength(2);
  expect(
    app.services.embeddingCalls.every(
      (c) => c.text.length <= 32 && c.truncate_inputs,
    ),
  ).toBe(true);
  expect(
    app.services.embeddingCalls.reduce((n, c) => n + c.text.length, 0),
  ).toBe(50);
  expect(app.services.upserts).toHaveLength(1);
  expect(app.services.d1Trips).toBe(2);
  expect(
    (
      await db
        .prepare(
          'SELECT count(*) AS n FROM memories WHERE embedding_marker IS NOT NULL',
        )
        .first()
    )?.n,
  ).toBe(50);
  app.services.resetCalls();
  await app.scheduled();
  expect(
    app.services.embeddingCalls.reduce((n, c) => n + c.text.length, 0),
  ).toBe(11);
  app.services.advance();
  for (const memory of manyMemories.slice(0, 61))
    expect(
      (
        await db
          .prepare('SELECT embedding_marker FROM memories WHERE id=?')
          .bind(memory.id)
          .first()
      )?.embedding_marker,
    ).toBe(`@cf/baai/bge-m3:${hash(memory.content)}`);
  expect(
    (await httpSearch(app, 'how do we deploy')).results.length,
  ).toBeGreaterThan(0);
  for (const memory of manyMemories.slice(0, 61))
    expect((await httpSearch(app, memory.content)).results).toContainEqual(
      expect.objectContaining({
        id: memory.id,
        match: expect.stringMatching(/^(meaning|both)$/),
      }),
    );
});
it('E14: model changes mark all memories outdated; failures keep keyword and the next scheduled run replaces every vector', async () => {
  await indexMemories(app, searchMemories);
  await app.setBindings({
    LOCAL_OWNER: 'synthetic-owner',
    LOCAL_ORIGIN: app.origin,
    EMBEDDING_MODEL: 'recorded-model-revision',
  });
  app.services.failIndex = true;
  await app.scheduled();
  expect((await httpSearch(app, 'pnpm verify')).results[0]).toMatchObject({
    id: memoryId(23),
    match: 'keyword',
  });
  expect((await marker(memoryId(20))).embedding_marker).toBe(
    `@cf/baai/bge-m3:${hash(spanishRelease)}`,
  );
  app.services.failIndex = false;
  app.services.resetCalls();
  await app.scheduled();
  expect(app.services.embeddingCalls.flatMap((c) => c.text)).toHaveLength(
    searchMemories.length,
  );
  expect(
    app.services.embeddingCalls.every(
      (c) => c.model === 'recorded-model-revision',
    ),
  ).toBe(true);
  expect((await marker(memoryId(20))).embedding_marker).toBe(
    `recorded-model-revision:${hash(spanishRelease)}`,
  );
  app.services.advance();
  expect((await httpSearch(app, 'how do we deploy')).results).toContainEqual(
    expect.objectContaining({ id: memoryId(20), match: 'meaning' }),
  );
  app.services.resetCalls();
  await app.scheduled();
  expect(app.services.embeddingCalls).toEqual([]);
});
it('E15: D1 drops old-hash and orphan vectors and marks a stale current marker pending for repair', async () => {
  await indexMemories(app, searchMemories);
  const original = app.services.upserts; // calls were reset, so derive the fixture vector from the recorder.
  expect(original).toEqual([]);
  const values = app.services.run('@cf/baai/bge-m3', {
    text: [spanishRelease],
    truncate_inputs: true,
  }).data[0];
  const bucket = hash('work').slice(0, 32);
  app.services.upsert([
    {
      id: memoryId(20),
      values,
      metadata: { bucket, contentHash: 'f'.repeat(64) },
    },
    {
      id: memoryId(999),
      values,
      metadata: { bucket, contentHash: hash(spanishRelease) },
    },
  ]);
  app.services.advance();
  const found = await httpSearch(app, 'how do we deploy');
  expect(found.results.map((r) => r.id)).not.toContain(memoryId(20));
  expect(found.results.map((r) => r.id)).not.toContain(memoryId(999));
  expect((await marker(memoryId(20))).embedding_marker).toBeNull();
  await app.scheduled();
  app.services.advance();
  expect(
    (await httpSearch(app, 'how do we deploy')).results.map((r) => r.id),
  ).toContain(memoryId(20));
});
it('real target: 16 KiB token-dense and large bilingual memories embed with truncation', async () => {
  await indexMemories(app, [
    memoryFixture(60, { content: denseContent }),
    memoryFixture(61, { content: largeContent }),
  ]);
  expect((await marker(memoryId(60))).embedding_marker).toBe(
    `@cf/baai/bge-m3:${hash(denseContent)}`,
  );
  expect(
    (await httpSearch(app, 'how do we deploy')).results.map((r) => r.id).sort(),
  ).toEqual([memoryId(60), memoryId(61)]);
  expect(app.services.missing.size).toBe(0);
});

it('the embedding marker cannot mark a newer version current after a late old-content write', async () => {
  await seedMemories(app, [searchMemories[0]]);
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
          arrived.resolve();
          await gate.promise;
        }
        return app.services.fetch(request);
      },
    },
  );
  const pending = app.scheduled();
  try {
    await arrived.promise;
    const db = await app.mf.getD1Database('DB');
    const content = searchMemories[3].content;
    await db.batch([
      db
        .prepare(
          'INSERT INTO memory_versions SELECT memory_id, 2, ?, tags, client_name, client_version, principal, machine_id, machine_name, working_directory, created_at FROM memory_versions WHERE memory_id=? AND version=1',
        )
        .bind(content, memoryId(20)),
      db
        .prepare(
          'UPDATE memories SET current_version=2, content_hash=? WHERE id=?',
        )
        .bind(hash(content), memoryId(20)),
    ]);
    gate.resolve();
    await pending;
    expect((await marker(memoryId(20))).embedding_marker).toBeNull();
    app.services.advance();
    expect((await httpSearch(app, 'how do we deploy')).results).toEqual([]);
    expect((await httpSearch(app, 'pnpm verify')).results).toContainEqual(
      expect.objectContaining({ id: memoryId(20), match: 'keyword' }),
    );
    await app.scheduled();
    app.services.advance();
    expect((await marker(memoryId(20))).embedding_marker).toBe(
      `@cf/baai/bge-m3:${hash(content)}`,
    );
    expect((await httpSearch(app, 'pnpm verify')).results).toContainEqual(
      expect.objectContaining({ id: memoryId(20), match: 'both' }),
    );
    await db
      .prepare(
        "INSERT INTO memories_fts(memories_fts, rank) VALUES ('integrity-check', 1)",
      )
      .run();
  } finally {
    gate.resolve();
    await pending;
  }
});
it('concurrent identical remembers schedule exactly one post-write embedding', async () => {
  const results = await Promise.all(
    Array.from({ length: 10 }, () => remembered(spanishRelease)),
  );
  expect(results.filter((r) => r.structuredContent?.created)).toHaveLength(1);
  const id = results[0].structuredContent?.id as string;
  await expect
    .poll(async () => (await marker(id)).embedding_marker)
    .toBe(`@cf/baai/bge-m3:${hash(spanishRelease)}`);
  expect(app.services.embeddingCalls).toHaveLength(1);
  expect(app.services.upserts).toHaveLength(1);
});
