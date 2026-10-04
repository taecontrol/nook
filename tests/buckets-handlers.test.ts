import { expect, it } from 'vitest';
import { handlerForPrincipal } from '../apps/worker/src/index.ts';
import { runtime } from './support/runtime.ts';

it.each(['list', 'create', 'delete'])(
  'E10: the real %s handler denies paths outside a work grant',
  async (operation) => {
    const build = handlerForPrincipal;
    const app = await runtime();
    try {
      const db = await app.mf.getD1Database('DB');
      await db.batch(
        ['personal', 'personal/finances', 'work', 'work/x'].map((path) =>
          db
            .prepare('INSERT INTO buckets(path, created_at) VALUES (?, ?)')
            .bind(path, '2026-10-04T00:00:00.000Z'),
        ),
      );
      const handler = build('owner@nook.test', db, ['work']);
      const response = await handler(
        new Request(
          'http://nook.test/api/buckets' +
            (operation === 'delete' ? '/personal%2Ffinances' : ''),
          {
            method:
              operation === 'list'
                ? 'GET'
                : operation === 'create'
                  ? 'POST'
                  : 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            ...(operation === 'create'
              ? { body: JSON.stringify({ path: 'personal/x' }) }
              : {}),
          },
        ),
      );
      if (operation === 'list') {
        expect(response.status).toBe(200);
        expect(
          (
            (await response.json()) as { buckets: { path: string }[] }
          ).buckets.map((b) => b.path),
        ).toEqual(['me', 'work', 'work/x']);
      } else expect(response.status).toBe(403);
      expect(
        (
          await db.prepare('SELECT path FROM buckets ORDER BY path').all()
        ).results.map((row) => row.path),
      ).toEqual(['me', 'personal', 'personal/finances', 'work', 'work/x']);
    } finally {
      await app.close();
    }
  },
);

it('E2: a write grant may create its missing ancestors outside the subtree', async () => {
  const build = handlerForPrincipal;
  const app = await runtime();
  try {
    const handler = build('owner@nook.test', await app.mf.getD1Database('DB'), [
      'work/acme',
    ]);
    const response = await handler(
      new Request('http://nook.test/api/buckets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'work/acme/x' }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: 'work/acme/x',
      created: true,
      createdAncestors: ['work', 'work/acme'],
    });
  } finally {
    await app.close();
  }
});
