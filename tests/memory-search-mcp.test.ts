import { createHash } from 'node:crypto';
import { Log, LogLevel } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  hostileQueries,
  identicalContent,
  searchMemories,
} from './fixtures/search-corpus.ts';
import { expectToolError, type ToolResult } from './support/mcp.ts';
import {
  manyMemories,
  memoryClient,
  memoryCounts,
  memoryFixture,
  memoryId,
  seedMemories,
  seedMemoryMachine,
  typicalMemories,
} from './support/memory.ts';
import {
  httpSearch,
  indexMemories,
  type SearchResponse,
  type SearchRuntime,
  searchRuntime,
} from './support/search.ts';

function results(result: ToolResult) {
  expect(result.isError, 'The real MCP search tool must succeed').not.toBe(
    true,
  );
  expect(
    result.structuredContent,
    'Search has a compact structured result',
  ).toBeDefined();
  return result.structuredContent as SearchResponse;
}
describe.each(['owner', 'machine'] as const)(
  'Memory search %s MCP',
  (endpoint) => {
    describe.each(['2026-07-28', '2025-06-18'] as const)('%s', (version) => {
      let app: SearchRuntime;
      let client: ReturnType<typeof memoryClient>;
      let token: string;
      const logs: string[] = [];
      beforeAll(async () => {
        app = await searchRuntime();
      });
      beforeEach(async () => {
        await (await app.mf.getD1Database('DB'))
          .prepare('DELETE FROM memories')
          .run();
        app.services.clear();
        app.services.failEmbedding = false;
        app.services.failIndex = false;
        app.services.ignoreFilter = false;
        ({ token } = await seedMemoryMachine(app, ['work']));
        client = memoryClient(app, version, {
          machine: endpoint === 'machine',
          headers: { Authorization: `Bearer ${token}` },
        });
      });
      afterAll(() => app?.close());
      const search = (query: string, extra: Record<string, unknown> = {}) =>
        client.call('search', { bucket: 'work/acme', query, ...extra });
      it.each([
        {
          corpus: 'seven search memories',
          seeds: searchMemories,
          size: 7,
          top: 3,
        },
        {
          corpus: 'combined 104-memory corpus',
          seeds: [...searchMemories, ...typicalMemories, ...manyMemories],
          size: 104,
          top: 10,
        },
      ])(
        'E1: $corpus finds the Spanish release by meaning in the top $top and returns only compact fields',
        async ({ seeds, size, top }) => {
          await seedMemories(app, seeds);
          expect((await memoryCounts(app)).memories).toBe(size);
          for (let offset = 0; offset < seeds.length; offset += 50)
            await app.scheduled();
          expect(app.services.upserts.flat()).toHaveLength(size);
          app.services.advance();
          app.services.resetCalls();
          const result = results(await search('how do we deploy'));
          expect(result.results.slice(0, top)).toContainEqual(
            expect.objectContaining({
              id: memoryId(20),
              title: 'Proceso de release',
              bucket: 'work',
              match: 'meaning',
            }),
          );
          expect(result.results.length).toBeLessThanOrEqual(10);
          for (const hit of result.results)
            expect(Object.keys(hit).sort()).toEqual([
              'bucket',
              'id',
              'match',
              'snippet',
              'tags',
              'title',
            ]);
          expect(result.meaning).toBe('available');
          expect(app.services.embeddingCalls).toHaveLength(1);
          expect(app.services.queries).toHaveLength(1);
          // Machine authentication and last use take their own existing D1 trip.
          expect(app.services.d1Trips).toBeLessThanOrEqual(
            endpoint === 'machine' ? 3 : 2,
          );
          expect(app.services.missing.size).toBe(0);
        },
      );
      it('E2/E3: exact verification ranks first; diacritics, case and prefixes match through real FTS5', async () => {
        await indexMemories(app, searchMemories);
        const exact = results(await search('pnpm verify'));
        expect(exact.results[0]).toMatchObject({ id: memoryId(23) });
        expect(['keyword', 'both']).toContain(exact.results[0].match);
        expect(exact.results[0].snippet).toContain('pnpm');
        expect(exact.results[0].snippet).toContain('verify');
        app.services.failEmbedding = true;
        const accents = results(await search('despliegue'));
        expect(accents.results.map((r) => r.id)).toEqual(
          expect.arrayContaining([memoryId(22), memoryId(24)]),
        );
        const prefix = results(await search('deploy'));
        expect(prefix.results.map((r) => r.id)).toEqual(
          expect.arrayContaining([memoryId(21), memoryId(25)]),
        );
      });
      it('E3: accents, case and prefixes match content independently of tags and alternate spellings', async () => {
        await seedMemories(app, [
          memoryFixture(482, {
            content: '# Despliégue\n\nAccent-only spelling.',
            tags: [],
          }),
          memoryFixture(483, {
            content: '# DESPLIEGUE\n\nUppercase-only spelling.',
            tags: [],
          }),
          memoryFixture(484, {
            content: '# Deploying\n\nPrefix-only spelling.',
            tags: [],
          }),
          memoryFixture(485, {
            content: '# Deployment\n\nAnother prefix-only spelling.',
            tags: [],
          }),
        ]);
        app.services.failEmbedding = true;
        expect(
          results(await search('despliegue')).results.map((r) => r.id),
        ).toEqual(expect.arrayContaining([memoryId(482), memoryId(483)]));
        expect(
          results(await search('deploy')).results.map((r) => r.id),
        ).toEqual(expect.arrayContaining([memoryId(484), memoryId(485)]));
      });
      it('E6: all required tags filter keyword matches as well as meaning matches', async () => {
        await seedMemories(app, searchMemories);
        app.services.failEmbedding = true;
        expect(
          results(await search('deployment', { tags: ['deploy', 'cli'] }))
            .results,
        ).toEqual([]);
        const found = results(
          await search('pnpm verify', { tags: ['deploy', 'cli'] }),
        );
        expect(found.results.map((r) => r.id)).toEqual([memoryId(23)]);
        expect(found.results[0].match).toBe('keyword');
      });
      it('E6: duplicate required tags are rejected before any meaning-service call', async () => {
        expectToolError(
          await search('how do we deploy', { tags: ['deploy', 'deploy'] }),
          'Use each tag only once.',
        );
        expect(app.services.embeddingCalls).toEqual([]);
        expect(app.services.queries).toEqual([]);
      });
      it.each([false, true])(
        'E4/E5: D1 enforces lineage even when Vectorize ignores the filter=%s; a narrow grant denies siblings',
        async (ignoreFilter) => {
          const seeds = [
            'work/acme',
            'work',
            'me',
            'work/other',
            'work/acme/api',
            'personal',
          ].map((bucket, i) =>
            memoryFixture(40 + i, { bucket, content: identicalContent }),
          );
          await indexMemories(app, seeds);
          app.services.ignoreFilter = ignoreFilter;
          const found = results(await search('shared deployment'));
          expect(found.results.map((r) => r.bucket).sort()).toEqual([
            'me',
            'work',
            'work/acme',
          ]);
          expect(found.results.every((r) => r.match === 'both')).toBe(true);
          app.services.failEmbedding = true;
          expect(
            results(await search('shared deployment'))
              .results.map((r) => r.bucket)
              .sort(),
          ).toEqual(['me', 'work', 'work/acme']);
          const machine = await seedMemoryMachine(app, ['work/acme']);
          const restricted = memoryClient(app, version, {
            machine: true,
            headers: { Authorization: `Bearer ${machine.token}` },
          });
          expectToolError(
            await restricted.call('search', {
              bucket: 'personal',
              query: 'shared deployment',
            }),
            'Access to this bucket is forbidden.',
          );
          expectToolError(
            await search('shared deployment', { bucket: 'work/missing' }),
            'Bucket not found.',
          );
          const allowed = results(
            await restricted.call('search', {
              bucket: 'work/acme',
              query: 'shared deployment',
            }),
          );
          expect(allowed.results.map((r) => r.bucket).sort()).toEqual([
            'me',
            'work',
            'work/acme',
          ]);
        },
      );
      it('E6: both keyword and meaning hits require every current tag', async () => {
        await indexMemories(app, searchMemories);
        const found = results(
          await search('how do we deploy', { tags: ['deploy', 'cli'] }),
        );
        expect(found.results.length).toBeGreaterThan(0);
        expect(
          found.results.every((r) =>
            ['deploy', 'cli'].every((tag) => r.tags.includes(tag)),
          ),
        ).toBe(true);
        expect(found.results.map((r) => r.id)).toEqual(
          expect.arrayContaining([memoryId(20)]),
        );
      });
      it('E7: invalid queries have fixed messages and FTS metacharacters cannot cause a parser error', async () => {
        for (const query of ['', ' \t\n '])
          expectToolError(await search(query), 'Enter a search query.');
        expectToolError(
          await search('x'.repeat(513)),
          'A search query can be at most 512 characters.',
        );
        await seedMemories(app, searchMemories);
        app.services.failEmbedding = true;
        for (const query of hostileQueries)
          expect(
            (await search(query)).isError,
            'Quoted prefix tokens never execute FTS syntax',
          ).not.toBe(true);
      });
      it('E8: a nonmatching keyword query returns an empty list; volume is capped at ten best-first results', async () => {
        await seedMemories(app, manyMemories);
        app.services.failEmbedding = true;
        expect(results(await search('kubernetes helm chart')).results).toEqual(
          [],
        );
        const hits = results(await search('deployment')).results;
        expect(hits).toHaveLength(10);
        expect(hits.every((r) => r.match === 'keyword')).toBe(true);
        const owner = await httpSearch(app, 'deployment');
        expect(owner.results.slice(0, 10).map((r) => r.id)).toEqual(
          hits.map((r) => r.id),
        );
      });
      it('E9: AI and vector failures degrade to keyword results; D1 failure and diagnostics never echo content or query', async () => {
        await seedMemories(app, [searchMemories[3]]);
        class PrivateLog extends Log {
          override log(message: string) {
            logs.push(message);
          }
        }
        await app.setBindings(
          {
            LOCAL_OWNER: 'synthetic-owner',
            LOCAL_ORIGIN: app.origin,
            EMBEDDING_MODEL: '@cf/baai/bge-m3',
          },
          {
            log: new PrivateLog(LogLevel.VERBOSE),
            handleRuntimeStdio(stdout, stderr) {
              for (const stream of [stdout, stderr])
                stream.on('data', (chunk) => logs.push(chunk.toString()));
            },
          },
        );
        for (const service of ['failEmbedding', 'failIndex'] as const) {
          app.services[service] = true;
          const response = await search('pnpm verify');
          expect(results(response)).toMatchObject({
            meaning: 'unavailable',
            results: [
              expect.objectContaining({ id: memoryId(23), match: 'keyword' }),
            ],
          });
          expect(response.content.map((c) => c.text).join('\n')).toMatch(
            /meaning.*unavailable.*incomplete/i,
          );
          app.services[service] = false;
        }
        const db = await app.mf.getD1Database('DB');
        await db
          .prepare('ALTER TABLE memory_versions RENAME TO unavailable_versions')
          .run();
        try {
          expectToolError(
            await search('pnpm verify'),
            'Service unavailable. Try again later.',
          );
        } finally {
          await db
            .prepare(
              'ALTER TABLE unavailable_versions RENAME TO memory_versions',
            )
            .run();
        }
        const audit = await db.prepare('SELECT * FROM audit_entries').all();
        for (const privateText of [
          'pnpm verify',
          searchMemories[3].content,
          'unavailable_versions',
        ])
          expect(logs.join('\n') + JSON.stringify(audit.results)).not.toContain(
            privateText,
          );
      });
      it('E10: a revoked token is unauthorized before any embedding or vector query', async () => {
        await indexMemories(app, searchMemories);
        expect(
          results(await search('how do we deploy')).results.length,
        ).toBeGreaterThan(0);
        expect(app.services.embeddingCalls).toHaveLength(1);
        app.services.resetCalls();
        const revoked = await seedMemoryMachine(app);
        await (await app.mf.getD1Database('DB'))
          .prepare('DELETE FROM machine_tokens WHERE token_hash=?')
          .bind(createHash('sha256').update(revoked.token).digest('hex'))
          .run();
        const machine = memoryClient(app, version, {
          machine: true,
          headers: { Authorization: `Bearer ${revoked.token}` },
        });
        const response = await machine.request('tools/call', {
          name: 'search',
          arguments: { bucket: 'work/acme', query: 'how do we deploy' },
        });
        expect(response.status).toBe(401);
        expect(app.services.embeddingCalls).toEqual([]);
        expect(app.services.queries).toEqual([]);
        expect(app.services.upserts).toEqual([]);
      });
      it('discovery: search describes explicit buckets, compact results and get, and is read-only', async () => {
        const tool = (await client.listTools()).tools.find(
          (t) => t.name === 'search',
        );
        expect(tool?.description).toMatch(/bucket.*explicitly/i);
        expect(tool?.description).toMatch(/get.*full content/i);
        expect(tool?.annotations).toMatchObject({ readOnlyHint: true });
        expect(Object.keys(tool?.inputSchema.properties as object)).toEqual([
          'bucket',
          'query',
          'tags',
        ]);
      });
    });
  },
);

describe('Memory search owner HTTP', () => {
  let app: SearchRuntime;
  beforeAll(async () => {
    app = await searchRuntime();
  });
  beforeEach(async () => {
    await (await app.mf.getD1Database('DB'))
      .prepare('DELETE FROM memories')
      .run();
    app.services.clear();
    app.services.failEmbedding = false;
    app.services.failIndex = false;
    app.services.ignoreFilter = false;
    await app.setBindings(
      {
        LOCAL_OWNER: 'synthetic-owner',
        LOCAL_ORIGIN: app.origin,
        EMBEDDING_MODEL: '@cf/baai/bge-m3',
      },
      { outboundService: (request) => app.services.fetch(request) },
    );
  });
  afterAll(() => app?.close());
  it.each([
    ['an empty query', '', 'Enter a search query.'],
    ['whitespace', ' \t\n', 'Enter a search query.'],
    [
      'over 512 characters',
      'a'.repeat(513),
      'A search query can be at most 512 characters.',
    ],
  ])(
    'E7: owner HTTP preserves validation for %s before AI/index calls',
    async (_label, query, message) => {
      const response = await fetch(
        `${app.origin}/api/memories/search?${new URLSearchParams({ bucket: 'work/acme', q: query })}`,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        _tag: 'InvalidMemorySearch',
        message,
      });
      expect(app.services.embeddingCalls).toEqual([]);
      expect(app.services.queries).toEqual([]);
    },
  );
  it('E4/E17: Only this bucket excludes ancestors from both search sources', async () => {
    await indexMemories(
      app,
      ['work/acme', 'work', 'me'].map((bucket, i) =>
        memoryFixture(40 + i, { bucket, content: identicalContent }),
      ),
    );
    const found = await httpSearch(
      app,
      'shared deployment',
      'work/acme',
      'bucket',
    );
    expect(found.results.map((hit) => hit.bucket)).toEqual(['work/acme']);
    expect(found.results[0].match).toBe('both');
    app.services.failEmbedding = true;
    const keywords = await httpSearch(
      app,
      'shared deployment',
      'work/acme',
      'bucket',
    );
    expect(keywords.results.map((hit) => hit.bucket)).toEqual(['work/acme']);
    expect(keywords.results[0].match).toBe('keyword');
  });
  it('ranking: equal fused scores put the newer memory first', async () => {
    await indexMemories(app, [
      memoryFixture(40, {
        bucket: 'work/acme',
        content: identicalContent,
        createdAt: '2026-10-10T00:00:00Z',
      }),
      memoryFixture(41, {
        bucket: 'work',
        content: identicalContent,
        createdAt: '2026-10-09T00:00:00Z',
      }),
    ]);
    const found = await httpSearch(app, 'shared deployment');
    expect(found.results.map((hit) => hit.id)).toEqual([
      memoryId(40),
      memoryId(41),
    ]);
    expect(found.results.every((hit) => hit.match === 'both')).toBe(true);
  });
  it('ranking: equal fused scores and dates put the greater id first', async () => {
    const createdAt = '2026-10-10T12:00:00.000Z';
    await indexMemories(app, [
      memoryFixture(40, { content: searchMemories[5].content, createdAt }),
      memoryFixture(41, { content: typicalMemories[1].content, createdAt }),
    ]);
    const found = await httpSearch(app, 'deploy');
    expect(found.results.every((hit) => hit.match === 'both')).toBe(true);
    expect(found.results.map((hit) => hit.id)).toEqual([
      memoryId(41),
      memoryId(40),
    ]);
  });
  it('keyword normalization: compatibility-width words find ordinary text', async () => {
    await seedMemories(app, searchMemories);
    app.services.failEmbedding = true;
    const found = await httpSearch(app, 'ｐｎｐｍ ｖｅｒｉｆｙ');
    expect(found.results[0]).toMatchObject({
      id: memoryId(23),
      match: 'keyword',
    });
  });
  it('keyword limits: an absent seventeenth term does not suppress a match for the first sixteen', async () => {
    const content =
      'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen';
    await seedMemories(app, [memoryFixture(486, { content, tags: [] })]);
    app.services.failEmbedding = true;
    const found = await httpSearch(app, `${content} seventeenth`);
    expect(found.meaning).toBe('unavailable');
    expect(found.results).toContainEqual(
      expect.objectContaining({ id: memoryId(486), match: 'keyword' }),
    );
  });
  it.each(['empty', 'extra', 'dimensions', 'infinite'] as const)(
    'E9: a malformed %s embedding response returns keywords without querying vectors',
    async (kind) => {
      await seedMemories(app, searchMemories);
      const values = app.services.run('@cf/baai/bge-m3', {
        text: ['pnpm verify'],
        truncate_inputs: true,
      }).data[0];
      app.services.resetCalls();
      let body: string;
      if (kind === 'empty') body = JSON.stringify({ data: [] });
      else if (kind === 'extra')
        body = JSON.stringify({ data: [values, values] });
      else if (kind === 'dimensions')
        body = JSON.stringify({ data: [values.slice(0, 1023)] });
      // A valid JSON numeric literal can overflow when parsed by the Worker.
      else body = `{"data":[[1e400,${values.slice(1).join(',')}]]}`;
      await app.setBindings(
        {
          LOCAL_OWNER: 'synthetic-owner',
          LOCAL_ORIGIN: app.origin,
          EMBEDDING_MODEL: '@cf/baai/bge-m3',
        },
        {
          outboundService: async (request) => {
            const normal = await app.services.fetch(request);
            return new URL(request.url).pathname === '/run'
              ? new Response(body, {
                  headers: { 'Content-Type': 'application/json' },
                })
              : normal;
          },
        },
      );
      const found = await httpSearch(app, 'pnpm verify');
      expect(found.meaning).toBe('unavailable');
      expect(found.results[0]).toMatchObject({
        id: memoryId(23),
        match: 'keyword',
      });
      expect(app.services.embeddingCalls).toHaveLength(1);
      expect(app.services.queries).toEqual([]);
    },
  );
  it('E9: a malformed Vectorize response reports unavailable meaning and preserves keywords', async () => {
    await seedMemories(app, searchMemories);
    await app.setBindings(
      {
        LOCAL_OWNER: 'synthetic-owner',
        LOCAL_ORIGIN: app.origin,
        EMBEDDING_MODEL: '@cf/baai/bge-m3',
      },
      {
        outboundService: async (request) => {
          const normal = await app.services.fetch(request);
          return new URL(request.url).pathname === '/query'
            ? Response.json({
                matches: [
                  { id: 23, metadata: { contentHash: 'f'.repeat(64) } },
                ],
              })
            : normal;
        },
      },
    );
    const found = await httpSearch(app, 'pnpm verify');
    expect(found.meaning).toBe('unavailable');
    expect(found.results[0]).toMatchObject({
      id: memoryId(23),
      match: 'keyword',
    });
    expect(app.services.embeddingCalls).toHaveLength(1);
    expect(app.services.queries).toHaveLength(1);
  });
});
