import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { memoryFixture, seedMemories } from './support/memory.ts';
import {
  httpSearch,
  type SearchRuntime,
  searchRuntime,
} from './support/search.ts';

let app: SearchRuntime;
beforeAll(async () => {
  app = await searchRuntime();
  // These tests exercise real FTS snippets while meaning is unavailable.
  app.services.failEmbedding = true;
});
beforeEach(async () => {
  await (await app.mf.getD1Database('DB'))
    .prepare('DELETE FROM memories')
    .run();
});
afterAll(() => app?.close());

it('E18: a clipped long keyword retains highlighting over its visible prefix', async () => {
  const word = 'a'.repeat(300);
  const row = memoryFixture(480, { content: `# Long word\n\n${word}` });
  await seedMemories(app, [row]);
  const found = await httpSearch(app, word);
  expect(found.meaning).toBe('unavailable');
  expect(found.results).toHaveLength(1);
  const hit = found.results[0];
  expect(hit.match).toBe('keyword');
  expect(hit.highlights).toHaveLength(1);
  const [start, end] = hit.highlights?.[0] ?? [];
  expect(hit.snippet.slice(start, end)).toMatch(/^a{200,}$/);
  expect(hit.snippet.endsWith('…')).toBe(true);
  expect(end).toBe(hit.snippet.length - 1);
});

it.each([
  { edge: 'end', content: `a${'😀'.repeat(150)}`, query: 'a' },
  {
    edge: 'start',
    content: `a${'😀'.repeat(60)} hello${' a'.repeat(80)}`,
    query: 'hello',
  },
])(
  'E18: clipping at the $edge keeps supplementary Unicode intact',
  async ({ content, query }) => {
    await seedMemories(app, [memoryFixture(481, { content })]);
    const found = await httpSearch(app, query);
    expect(found.results).toHaveLength(1);
    const hit = found.results[0];
    expect(hit.snippet.isWellFormed()).toBe(true);
    expect(hit.highlights).toHaveLength(1);
    const [start, end] = hit.highlights?.[0] ?? [];
    expect(hit.snippet.slice(start, end)).toBe(query);
  },
);
