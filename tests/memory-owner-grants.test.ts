import { expect, it } from 'vitest';
import { handlerForPrincipal } from '../apps/worker/src/index.ts';
import {
  memoryFixture,
  memoryId,
  memoryRuntime,
  seedMemories,
} from './support/memory.ts';
import { forgetSnapshot } from './support/memory-forget.ts';

it('owner HTTP search denies a sibling bucket outside its grant', async () => {
  const app = await memoryRuntime();
  try {
    const privateContent = 'synthetic-private-sibling-memory';
    await seedMemories(app, [
      memoryFixture(1, {
        bucket: 'personal',
        content: privateContent,
      }),
    ]);
    const handler = handlerForPrincipal(
      'owner@nook.test',
      await app.mf.getD1Database('DB'),
      ['work'],
    );
    const response = await handler(
      new Request(
        'http://nook.test/api/memories/search?bucket=personal&q=synthetic',
      ),
    );
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ _tag: 'Forbidden' });
    expect(body).not.toContain(privateContent);
  } finally {
    await app.close();
  }
});

it('owner HTTP forget denies readable ancestors before version validation without changing storage', async () => {
  const app = await memoryRuntime();
  try {
    await seedMemories(app, [
      memoryFixture(1, { bucket: 'work' }),
      memoryFixture(2, { bucket: 'me' }),
    ]);
    const handler = handlerForPrincipal(
      'owner@nook.test',
      await app.mf.getD1Database('DB'),
      ['work/acme'],
    );
    const before = await forgetSnapshot(app);
    for (const id of [memoryId(1), memoryId(2)]) {
      const readable = await handler(
        new Request(`http://nook.test/api/memories/${id}`),
      );
      expect(readable.status).toBe(200);
      const denied = await handler(
        new Request(`http://nook.test/api/memories/${id}?expectedVersion=0`, {
          method: 'DELETE',
        }),
      );
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ _tag: 'Forbidden' });
    }
    expect(await forgetSnapshot(app)).toEqual(before);
  } finally {
    await app.close();
  }
});
