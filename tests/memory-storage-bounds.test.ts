import { expect, it } from 'vitest';
import { memories } from './fixtures/memory-history.ts';
import {
  manyMemories,
  memoryId,
  memoryRuntime,
  seedMemories,
  typicalMemories,
} from './support/memory.ts';
import { seedHistory } from './support/memory-history.ts';
import { httpSearch, indexMemories, searchRuntime } from './support/search.ts';

it('meaning search asks Vectorize for 50 candidates', async () => {
  const app = await searchRuntime();
  try {
    await indexMemories(app, [typicalMemories[1]]);
    const found = await httpSearch(app, 'deploy');
    expect(found.meaning).toBe('available');
    expect(app.services.queries).toEqual([
      expect.objectContaining({ topK: 50 }),
    ]);
  } finally {
    await app.close();
  }
});

it('51 keyword matches include the fiftieth candidate and exclude the fifty-first', async () => {
  const app = await searchRuntime();
  try {
    // Equal-length recorded notes and dates leave descending ids as the
    // keyword tiebreaker. Skip the fixtures with expanded titles.
    const seeds = manyMemories
      .filter((_, index) => index >= 10 && index % 13 !== 0)
      .slice(0, 51)
      .map((memory, index) => ({
        ...memory,
        id: memoryId(800 + index),
        bucket: 'work/acme',
        tags: ['deploy'],
        createdAt: '2026-10-10T12:00:00.000Z',
      }));
    // Meaning matches at both edges make keyword membership visible in the
    // public result's match field despite the final twenty-result limit.
    await indexMemories(app, seeds.slice(0, 2));
    await seedMemories(app, seeds.slice(2));
    const found = await httpSearch(app, 'deploy', 'work/acme', 'bucket');
    expect(found.meaning).toBe('available');
    expect(found.results[0]).toMatchObject({ id: seeds[1].id, match: 'both' });
    expect(found.results).toContainEqual(
      expect.objectContaining({ id: seeds[0].id, match: 'meaning' }),
    );
  } finally {
    await app.close();
  }
});

it('owner history pages 25 versions and still accepts an earlier 26-version page boundary', async () => {
  const app = await memoryRuntime();
  try {
    const fixture = memories[1];
    await seedHistory(app, [
      {
        ...fixture,
        versions: Array.from({ length: 27 }, (_, index) => ({
          ...fixture.versions[0],
          content: `Synthetic history version ${index + 1}.`,
          minutesAgo: 27 - index,
        })),
      },
    ]);
    const first = await fetch(
      `${app.origin}/api/memories/${fixture.id}/versions`,
    );
    expect(first.status).toBe(200);
    const page = await first.json();
    expect(
      page.versions.map((version: { version: number }) => version.version),
    ).toEqual(Array.from({ length: 25 }, (_, index) => 27 - index));
    expect(page.next).toBe(3);
    const next = await fetch(
      `${app.origin}/api/memories/${fixture.id}/versions?before=${page.next}`,
    );
    expect(next.status).toBe(200);
    expect(await next.json()).toMatchObject({
      versions: [{ version: 2 }, { version: 1 }],
      next: null,
    });
    const previousCursor = await fetch(
      `${app.origin}/api/memories/${fixture.id}/versions?before=2`,
    );
    expect(previousCursor.status).toBe(200);
    expect(await previousCursor.json()).toMatchObject({
      versions: [{ version: 1 }],
      next: null,
    });
  } finally {
    await app.close();
  }
});

it('scheduled repair keeps its 32-memory embedding chunks', async () => {
  const app = await searchRuntime();
  try {
    await seedMemories(app, manyMemories.slice(0, 50));
    await app.scheduled();
    expect(app.services.embeddingCalls.map((call) => call.text.length)).toEqual(
      [32, 18],
    );
  } finally {
    await app.close();
  }
});

it('scheduled inspection waits ten minutes after the last update', async () => {
  const app = await searchRuntime();
  try {
    const memory = manyMemories[0];
    await indexMemories(app, [memory]);
    await (await app.mf.getD1Database('DB'))
      .prepare('UPDATE memories SET updated_at=? WHERE id=?')
      .bind('2030-01-01T00:00:00.000Z', memory.id)
      .run();
    await app.scheduled(new Date('2030-01-01T00:09:59Z'));
    expect(app.services.inspections).toEqual([]);
    await app.scheduled(new Date('2030-01-01T00:10:01Z'));
    expect(app.services.inspections).toEqual([[memory.id]]);
  } finally {
    await app.close();
  }
});

it('the five-minute rotation slot selects the second inspection page', async () => {
  const app = await searchRuntime();
  try {
    const seeds = manyMemories.slice(0, 51);
    await indexMemories(app, seeds);
    await app.scheduled(new Date('2030-01-01T00:00:00Z'));
    app.services.advance();
    app.services.resetCalls();
    await app.scheduled(new Date('2030-01-01T00:25:00Z'));
    expect(app.services.inspections).toEqual([[seeds[50].id]]);
  } finally {
    await app.close();
  }
});
