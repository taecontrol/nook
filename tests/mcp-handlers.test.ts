import { expect, it } from 'vitest';
import { handlerForPrincipal } from '../apps/worker/src/index.ts';
import {
  expectToolError,
  expectToolSuccess,
  mcpDriver,
} from './support/mcp.ts';
import { runtime } from './support/runtime.ts';

it('E7: the principal grant filters lists and denies both writes outside its subtree', async () => {
  const app = await runtime();
  try {
    const db = await app.mf.getD1Database('DB');
    await db.batch(
      ['personal', 'personal/finances', 'work', 'work/x', 'workshop'].map(
        (path) =>
          db
            .prepare('INSERT INTO buckets VALUES (?, ?)')
            .bind(path, '2026-10-04T00:00:00.000Z'),
      ),
    );
    const before = (
      await db.prepare('SELECT * FROM buckets ORDER BY path').all()
    ).results;
    const driver = mcpDriver(
      'http://nook.test',
      '2026-07-28',
      {},
      handlerForPrincipal('owner@nook.test', db, ['work']),
    );
    expectToolSuccess(await driver.call('list_buckets'), {
      buckets: before
        .filter((row) => ['me', 'work', 'work/x'].includes(row.path as string))
        .map((row) => ({ path: row.path, createdAt: row.created_at })),
    });
    for (const [name, path] of [
      ['create_bucket', 'personal/x'],
      ['create_bucket', 'workshop/x'],
      ['delete_bucket', 'personal/finances'],
    ])
      expectToolError(
        await driver.call(name, { path }),
        'Access to this bucket is forbidden.',
      );
    expect(
      (await db.prepare('SELECT * FROM buckets ORDER BY path').all()).results,
    ).toEqual(before);
    expectToolSuccess(await driver.call('create_bucket', { path: 'work/y' }), {
      path: 'work/y',
      created: true,
      createdAncestors: [],
    });
    expectToolSuccess(await driver.call('delete_bucket', { path: 'work/x' }), {
      path: 'work/x',
    });
  } finally {
    await app.close();
  }
});

it('both MCP writes sanitize synchronous D1 failures and leave rows unchanged', async () => {
  const app = await runtime();
  try {
    const db = await app.mf.getD1Database('DB');
    await db
      .prepare(
        "INSERT INTO buckets VALUES ('work', '2026-10-04T00:00:00.000Z')",
      )
      .run();
    const before = (
      await db.prepare('SELECT * FROM buckets ORDER BY path').all()
    ).results;
    const failing = new Proxy(db, {
      get(target, key) {
        if (key !== 'prepare') return Reflect.get(target, key, target);
        return (query: string) =>
          new Proxy(target.prepare(query), {
            get(statement, property) {
              if (property === 'bind')
                return () => {
                  throw new Error('Synthetic private D1 binding failure.');
                };
              return Reflect.get(statement, property, statement);
            },
          });
      },
    });
    const driver = mcpDriver(
      'http://nook.test',
      '2026-07-28',
      {},
      handlerForPrincipal('owner@nook.test', failing),
    );
    for (const [name, path] of [
      ['create_bucket', 'work/new'],
      ['delete_bucket', 'work'],
    ])
      expectToolError(
        await driver.call(name, { path }),
        'Service unavailable. Try again later.',
      );
    expect(
      (await db.prepare('SELECT * FROM buckets ORDER BY path').all()).results,
    ).toEqual(before);
  } finally {
    await app.close();
  }
});
