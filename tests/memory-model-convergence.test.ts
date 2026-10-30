import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import worker from '../apps/worker/src/index.ts';
import type { SearchBindings } from '../apps/worker/src/memory-index.ts';
import { spanishRelease } from './fixtures/search-corpus.ts';
import { deferred } from './support/machines.ts';
import { memoryClient, memoryFixture } from './support/memory.ts';
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

const oldModel = 'synthetic-model-a';
const currentModel = 'synthetic-model-b';
const query = 'how do we deploy';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const contentHash = hash(spanishRelease);
const vector = (x: number, y = 0) => [x, y, ...Array<number>(1022).fill(0)];

it.each(['received', 'lost'] as const)(
  'E18: scheduled inspection restores current-model recall after a late old-model upsert with its response %s',
  async (response) => {
    const distractors = Array.from(
      { length: 20 },
      (_, i) => `# Synthetic unrelated note ${i}\n\nArchive item ${i}.`,
    );
    const gate = deferred();
    let initialEmbeddingUnavailable = true;
    let oldUpsertWaiting = false;
    let oldUpsertAccepted = false;
    const outboundService = async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === '/run') {
        const [model, input] = (await request.json()) as [
          string,
          { text: string[]; truncate_inputs?: boolean },
        ];
        app.services.embeddingCalls.push({ model, ...input });
        if (initialEmbeddingUnavailable)
          return new Response('Synthetic initial AI outage.', { status: 503 });
        expect([oldModel, currentModel]).toContain(model);
        const data = input.text.map((text) => {
          if (text === query) return vector(1);
          if (text === spanishRelease)
            return vector(model === oldModel ? -1 : 1);
          expect(distractors).toContain(text);
          return vector(0, 1);
        });
        // Only the AI boundary synthesizes vectors; D1 and vector mutations
        // come exclusively from real remember and scheduled operations.
        return Response.json({ data, shape: [data.length, 1024] });
      }
      if (
        path === '/upsert' &&
        request.headers.get('x-test-model') === oldModel
      ) {
        oldUpsertWaiting = true;
        await gate.promise;
        const accepted = await app.services.fetch(request);
        expect(accepted.ok).toBe(true);
        oldUpsertAccepted = true;
        // The external write succeeds, but this invocation cannot acknowledge
        // it in D1 when its transport response is lost.
        return response === 'lost'
          ? new Response('Synthetic upsert response lost.', { status: 503 })
          : accepted;
      }
      return app.services.fetch(request);
    };
    await app.setBindings(
      {
        LOCAL_OWNER: 'synthetic-owner',
        LOCAL_ORIGIN: app.origin,
        EMBEDDING_MODEL: currentModel,
      },
      { outboundService },
    );

    const client = memoryClient(app, '2026-07-28');
    const remembered = await client.call('remember', {
      bucket: 'work/acme',
      content: spanishRelease,
    });
    expect(remembered.structuredContent).toMatchObject({ created: true });
    const id = remembered.structuredContent?.id as string;
    for (const content of distractors)
      expect(
        (await client.call('remember', { bucket: 'work/acme', content }))
          .structuredContent,
      ).toMatchObject({ created: true });
    await expect.poll(() => app.services.embeddingCalls.length).toBe(21);
    expect(app.services.upserts).toEqual([]);
    const db = await app.mf.getD1Database('DB');
    const marker = async () =>
      (
        await db
          .prepare('SELECT embedding_marker FROM memories WHERE id=?')
          .bind(id)
          .first()
      )?.embedding_marker;
    expect(await marker()).toBeNull();
    initialEmbeddingUnavailable = false;

    // Keep both deployments' model bindings immutable while sharing the same
    // real D1 and index. The old invocation runs the production cron handler.
    const invoke = async <T>(method: string, args: unknown[]): Promise<T> => {
      const reply = await outboundService(
        new Request(`https://nook-search-fixture.invalid/${method}`, {
          method: 'POST',
          headers: { 'x-test-model': oldModel },
          body: JSON.stringify(args),
        }),
      );
      if (!reply.ok) throw new Error('Synthetic search transport failure.');
      return (await reply.json()) as T;
    };
    const oldBindings: SearchBindings = {
      EMBEDDING_MODEL: oldModel,
      AI: { run: (...args) => invoke('run', args) },
      MEMORY_INDEX: {
        query: (...args) => invoke('query', args),
        upsert: (...args) => invoke('upsert', args),
        getByIds: (...args) => invoke('getByIds', args),
        deleteByIds: (...args) => invoke('deleteByIds', args),
      },
    };
    const startedAt = Date.now();
    const oldJob = worker.scheduled(
      {
        cron: '*/5 * * * *',
        scheduledTime: startedAt,
        noRetry() {},
      },
      { ...oldBindings, DB: db },
    );
    try {
      // Reaching upsert proves A already passed its post-AI freshness check.
      await expect.poll(() => oldUpsertWaiting).toBe(true);
      await app.scheduled(new Date(startedAt));
      expect(await marker()).toBe(`${currentModel}:${contentHash}`);
      app.services.advance();
      expect((await httpSearch(app, query)).results[0]).toMatchObject({
        id,
        match: 'meaning',
      });

      gate.resolve();
      await oldJob;
      expect(oldUpsertAccepted).toBe(true);
      expect(await marker()).toBe(
        `${response === 'lost' ? currentModel : oldModel}:${contentHash}`,
      );
      app.services.advance();
      const late = app.services.getByIds([id])[0];
      expect(late.values.slice(0, 2)).toEqual([-1, 0]);
      expect(late.metadata).toMatchObject({
        bucket: hash('work/acme').slice(0, 32),
        contentHash,
        model: oldModel,
      });

      app.services.resetCalls();
      // All 21 memories fit in one inspection window. Allow inspection,
      // next-run repair and a further inspection, with fully propagated writes.
      for (const minutes of [15, 20, 25]) {
        await app.scheduled(new Date(startedAt + minutes * 60_000));
        app.services.advance();
      }
      expect(app.services.inspections.flat()).toContain(id);
      expect(await marker()).toBe(`${currentModel}:${contentHash}`);
      const repaired = app.services.getByIds([id])[0];
      const found = await httpSearch(app, query);
      expect(found.meaning).toBe('available');
      expect
        .soft(
          repaired.values.slice(0, 2),
          'Scheduled repair must restore the current-model vector.',
        )
        .toEqual([1, 0]);
      expect(
        found.results.some((m) => m.id === id && m.match === 'meaning'),
        'Scheduled repair must restore meaning recall without a search trigger.',
      ).toBe(true);
    } finally {
      gate.resolve();
      await oldJob;
    }
  },
);

it('E18: a vector without model identity, from before model metadata or an old Worker mid-deploy, is re-embedded once while it keeps serving recall', async () => {
  const memory = memoryFixture(20, { content: spanishRelease });
  await indexMemories(app, [memory]);
  const model = '@cf/baai/bge-m3';
  const metadata = { bucket: hash(memory.bucket).slice(0, 32), contentHash };
  const [written] = app.services.getByIds([memory.id]);
  expect(written.metadata).toEqual({ ...metadata, model });
  const db = await app.mf.getD1Database('DB');
  const marker = async () =>
    (
      await db
        .prepare('SELECT embedding_marker FROM memories WHERE id=?')
        .bind(memory.id)
        .first()
    )?.embedding_marker;
  expect(await marker()).toBe(`${model}:${contentHash}`);
  // A Worker without model metadata acknowledges the same marker format.
  app.services.upsert([{ id: memory.id, values: written.values, metadata }]);
  app.services.advance();
  app.services.resetCalls();
  const recalled = async () =>
    (await httpSearch(app, query)).results.some(
      (m) => m.id === memory.id && m.match === 'meaning',
    );

  await app.scheduled(new Date('2030-01-01T00:00:00Z'));
  expect(app.services.inspections.flat()).toContain(memory.id);
  expect(app.services.embeddingCalls).toEqual([]);
  expect(await marker()).toBeNull();
  expect(await recalled()).toBe(true);

  await app.scheduled(new Date('2030-01-01T00:05:00Z'));
  app.services.advance();
  expect(app.services.embeddingCalls.flatMap((c) => c.text)).toEqual([
    spanishRelease,
  ]);
  expect(app.services.getByIds([memory.id])[0].metadata).toEqual({
    ...metadata,
    model,
  });
  expect(await marker()).toBe(`${model}:${contentHash}`);
  expect(await recalled()).toBe(true);

  app.services.resetCalls();
  for (const minutes of [10, 15])
    await app.scheduled(new Date(Date.UTC(2030, 0, 1, 0, minutes)));
  expect(app.services.inspections.flat()).toContain(memory.id);
  expect(app.services.embeddingCalls).toEqual([]);
  expect(await marker()).toBe(`${model}:${contentHash}`);
});
