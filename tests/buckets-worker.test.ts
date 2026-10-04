import { beforeEach, expect, it } from 'vitest';
import { access, accessFixture } from './support/access.ts';
import { invalidPaths } from './support/bucket-paths.ts';
import { runtime, type TestRuntime } from './support/runtime.ts';

let app: TestRuntime;
let assertion: string;
beforeEach(async () => {
  const issuer = await accessFixture();
  assertion = await issuer.assertion();
  const started = await runtime({
    bindings: access,
    outboundService: issuer.outboundService,
  });
  app = started;
  return () => started.close();
});
function request(method: string, path = '', origin?: string) {
  return fetch(
    `${app.origin}/api/buckets${method === 'DELETE' ? `/${encodeURIComponent(path)}` : ''}`,
    {
      method,
      headers: {
        'Cf-Access-Jwt-Assertion': assertion,
        'Content-Type': 'application/json',
        ...(origin ? { Origin: origin } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify({ path }) } : {}),
    },
  );
}
async function paths() {
  const response = await request('GET');
  expect(response.status, 'Buckets list endpoint is missing').toBe(200);
  const data = (await response.json()) as {
    buckets: { path: string; createdAt: string }[];
  };
  for (const bucket of data.buckets)
    expect(new Date(bucket.createdAt).toISOString()).toBe(bucket.createdAt);
  return data.buckets.map((bucket) => bucket.path);
}
it.each(invalidPaths)(
  'E1: POST rejects %s, reports the exact message, and writes nothing',
  async (path, message) => {
    const response = await request('POST', path);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ message });
    expect(await paths()).toEqual(['me']);
  },
);
it('E5: the first migration creates exactly me', async () => {
  expect(await paths()).toEqual(['me']);
  const db = await app.mf.getD1Database('DB');
  await expect(
    db.prepare("DELETE FROM buckets WHERE path='me'").run(),
  ).rejects.toThrow('The me bucket cannot be deleted.');
  expect(await paths()).toEqual(['me']);
});
it('E6/E7: creation adds missing ancestors, and repeats including me change nothing', async () => {
  const created = await request('POST', 'work/acme');
  expect(created.status).toBe(200);
  expect(await created.json()).toEqual({
    path: 'work/acme',
    created: true,
    createdAncestors: ['work'],
  });
  expect(await paths()).toEqual(['me', 'work', 'work/acme']);
  const before = await (await request('GET')).json();
  for (const path of ['work/acme', 'me']) {
    expect(await (await request('POST', path)).json()).toEqual({
      path,
      created: false,
      createdAncestors: [],
    });
  }
  expect(await (await request('GET')).json()).toEqual(before);
});
it('E8: deleting an empty leaf leaves its parent', async () => {
  await request('POST', 'work/acme');
  expect((await request('DELETE', 'work/acme')).status).toBe(204);
  expect(await paths()).toEqual(['me', 'work']);
});
it('E8: prefix neighbors do not prevent deleting an empty bucket', async () => {
  for (const path of ['work', 'workshop', 'work-archive'])
    expect((await request('POST', path)).status).toBe(200);
  expect((await request('DELETE', 'work')).status).toBe(204);
  expect(await paths()).toEqual(['me', 'work-archive', 'workshop']);
});
it.each(['GET', 'POST', 'DELETE'])(
  'D1 failures in %s return only 503 and leave the rows unchanged',
  async (method) => {
    const db = await app.mf.getD1Database('DB');
    await request('POST', 'work/kept');
    const before = (
      await db.prepare('SELECT * FROM buckets ORDER BY path').all()
    ).results;
    if (method === 'GET')
      await db
        .prepare('ALTER TABLE buckets RENAME TO unavailable_buckets')
        .run();
    else
      await db
        .prepare(
          method === 'POST'
            ? "CREATE TRIGGER synthetic_failure BEFORE INSERT ON buckets WHEN NEW.path = 'other/x/y' BEGIN SELECT RAISE(ABORT, 'synthetic private D1 error'); END"
            : "CREATE TRIGGER synthetic_failure BEFORE DELETE ON buckets WHEN OLD.path = 'work/kept' BEGIN SELECT RAISE(ABORT, 'synthetic private D1 error'); END",
        )
        .run();
    const response = await request(
      method,
      method === 'POST' ? 'other/x/y' : 'work/kept',
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ _tag: 'ServiceUnavailable' });
    expect(
      (
        await db
          .prepare(
            `SELECT * FROM ${method === 'GET' ? 'unavailable_buckets' : 'buckets'} ORDER BY path`,
          )
          .all()
      ).results,
    ).toEqual(before);
  },
);
it.each([
  ['work', 409, 'Delete its child buckets first.'],
  ['me', 400, 'The me bucket cannot be deleted.'],
  ['missing', 404, 'Bucket not found.'],
])('E9: deleting %s fails without changes', async (path, status, message) => {
  await request('POST', 'work/acme');
  const before = await (await request('GET')).json();
  const response = await request('DELETE', String(path));
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ message });
  expect(await (await request('GET')).json()).toEqual(before);
});
it.each(['POST', 'DELETE'])(
  'E11: %s denies a foreign Origin and allows absent/same Origin',
  async (method) => {
    await request('POST', 'work/x');
    const before = await paths();
    expect(
      (await request(method, 'work/x', 'https://foreign.test')).status,
    ).toBe(403);
    expect(await paths()).toEqual(before);
    expect((await request(method, 'work/x', app.origin)).status).toBe(
      method === 'DELETE' ? 204 : 200,
    );
    expect((await request('POST', 'work/cli')).status).toBe(200);
    expect((await request('DELETE', 'work/cli')).status).toBe(204);
  },
);
it.each(['absent', 'empty', 'children'])(
  'E12: create/delete interleavings preserve parents when work/x is %s',
  async (state) => {
    if (state !== 'absent') await request('POST', 'work/x');
    if (state === 'children') await request('POST', 'work/x/z');
    const responses = await Promise.all([
      request('POST', 'work/x/y'),
      request('DELETE', 'work/x'),
    ]);
    expect(responses[0].status).toBe(200);
    expect(
      state === 'children'
        ? [409]
        : state === 'absent'
          ? [404, 409]
          : [204, 409],
    ).toContain(responses[1].status);
    const all = await paths();
    expect(all).toContain('work/x/y');
    for (const path of all)
      if (path.includes('/'))
        expect(all).toContain(path.slice(0, path.lastIndexOf('/')));
  },
);
it.each(['delete first', 'create first'])(
  'E12 Q20: an initially absent parent supports %s without an orphan',
  async (order) => {
    if (order === 'delete first')
      expect((await request('DELETE', 'work/x')).status).toBe(404);
    expect((await request('POST', 'work/x/y')).status).toBe(200);
    if (order === 'create first')
      expect((await request('DELETE', 'work/x')).status).toBe(409);
    expect(await paths()).toEqual(['me', 'work', 'work/x', 'work/x/y']);
  },
);
