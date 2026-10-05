import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { access, accessFixture } from './support/access.ts';
import { invalidPaths } from './support/bucket-paths.ts';
import {
  expectToolError,
  expectToolSuccess,
  mcpDriver,
  mcpRequest,
} from './support/mcp.ts';
import { runtime, type TestRuntime } from './support/runtime.ts';

let app: TestRuntime;
let driver: ReturnType<typeof mcpDriver>;
let issuer: Awaited<ReturnType<typeof accessFixture>>;
beforeAll(async () => {
  issuer = await accessFixture();
  app = await runtime({
    bindings: access,
    outboundService: issuer.outboundService,
  });
  driver = mcpDriver(app.origin, '2026-07-28', {
    'Cf-Access-Jwt-Assertion': await issuer.assertion(),
  });
});
beforeEach(async () => {
  const db = await app.mf.getD1Database('DB');
  await db.prepare("DELETE FROM buckets WHERE path <> 'me'").run();
});
afterAll(() => app?.close());

async function snapshot(table = 'buckets') {
  const db = await app.mf.getD1Database('DB');
  return (await db.prepare(`SELECT * FROM ${table} ORDER BY path`).all())
    .results;
}
async function listed() {
  const result = await driver.call('list_buckets');
  const response = await fetch(`${app.origin}/api/buckets`, {
    headers: { 'Cf-Access-Jwt-Assertion': await issuer.assertion() },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    buckets: { path: string; createdAt: string }[];
  };
  expectToolSuccess(result, body);
  for (const bucket of body.buckets)
    expect(new Date(bucket.createdAt).toISOString()).toBe(bucket.createdAt);
  return body.buckets.map((bucket) => bucket.path);
}

it('E1: discovery exposes exactly the three bucket tools, annotations and schemas', async () => {
  const { tools } = await driver.listTools();
  expect(tools.map((tool) => tool.name).sort()).toEqual([
    'create_bucket',
    'delete_bucket',
    'list_buckets',
  ]);
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  expect(byName.list_buckets.annotations).toMatchObject({ readOnlyHint: true });
  expect(byName.create_bucket.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  });
  expect(byName.delete_bucket.annotations).toMatchObject({
    destructiveHint: true,
    idempotentHint: false,
  });
  expect(byName.list_buckets.inputSchema).toMatchObject({
    type: 'object',
  });
  expect(
    Object.keys((byName.list_buckets.inputSchema.properties as object) ?? {}),
  ).toEqual([]);
  expect(byName.list_buckets.inputSchema.required ?? []).toEqual([]);
  for (const name of ['create_bucket', 'delete_bucket']) {
    expect(byName[name].inputSchema).toMatchObject({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    });
    expect(Object.keys(byName[name].inputSchema.properties as object)).toEqual([
      'path',
    ]);
  }
  expect(byName.list_buckets.outputSchema).toMatchObject({
    type: 'object',
    required: ['buckets'],
    properties: {
      buckets: {
        type: 'array',
        items: {
          type: 'object',
          required: ['path', 'createdAt'],
          properties: {
            path: { type: 'string' },
            createdAt: { type: 'string' },
          },
        },
      },
    },
  });
  expect(byName.create_bucket.outputSchema).toMatchObject({
    type: 'object',
    required: ['path', 'created', 'createdAncestors'],
    properties: {
      path: { type: 'string' },
      created: { type: 'boolean' },
      createdAncestors: { type: 'array', items: { type: 'string' } },
    },
  });
  expect(byName.delete_bucket.outputSchema).toMatchObject({
    type: 'object',
    required: ['path'],
    properties: { path: { type: 'string' } },
  });
});
it('E2: discovered descriptions retain explicit buckets, owner choices and write confirmations', async () => {
  const { tools } = await driver.listTools();
  for (const [name, requirements] of [
    [
      'list_buckets',
      [
        'List the visible buckets.',
        'every Nook operation names its bucket explicitly',
      ],
    ],
    [
      'create_bucket',
      [
        'Create a bucket and any missing ancestors.',
        'This operation is idempotent.',
        'Ask the owner which bucket applies when you do not know',
        'get their confirmation before creating one',
      ],
    ],
    [
      'delete_bucket',
      [
        'Delete an empty bucket to correct a mistaken creation.',
        'The me bucket and buckets with children cannot be deleted.',
        'Confirm with the owner before deleting.',
      ],
    ],
  ] as const) {
    const description = tools.find((tool) => tool.name === name)?.description;
    for (const requirement of requirements)
      expect(description).toContain(requirement);
  }
});
it('E3/E4: create adds missing ancestors, returns the API body and repeats change nothing', async () => {
  expect(await listed()).toEqual(['me']);
  expectToolSuccess(
    await driver.call('create_bucket', { path: 'work/acme' }),
    {
      path: 'work/acme',
      created: true,
      createdAncestors: ['work'],
    },
  );
  expect(await listed()).toEqual(['me', 'work', 'work/acme']);
  const before = await snapshot();
  for (const path of ['work/acme', 'me'])
    expectToolSuccess(await driver.call('create_bucket', { path }), {
      path,
      created: false,
      createdAncestors: [],
    });
  expect(await snapshot()).toEqual(before);
});
it.each(invalidPaths)(
  'E5: both writes reject %s with the contract message and no changes',
  async (path, message) => {
    const before = await snapshot();
    for (const name of ['create_bucket', 'delete_bucket']) {
      expectToolError(await driver.call(name, { path }), message);
      expect(await snapshot()).toEqual(before);
    }
  },
);
it('E6: delete removes only an empty leaf and returns its path', async () => {
  await driver.call('create_bucket', { path: 'work/acme' });
  expectToolSuccess(
    await driver.call('delete_bucket', { path: 'work/acme' }),
    { path: 'work/acme' },
  );
  expect(await listed()).toEqual(['me', 'work']);
});
it.each([
  ['work', 'Delete its child buckets first.'],
  ['me', 'The me bucket cannot be deleted.'],
  ['missing', 'Bucket not found.'],
])(
  'E6: delete %s reports the domain error and changes nothing',
  async (path, message) => {
    await driver.call('create_bucket', { path: 'work/acme' });
    const before = await snapshot();
    expectToolError(await driver.call('delete_bucket', { path }), message);
    expect(await snapshot()).toEqual(before);
  },
);

it.each(['list_buckets', 'create_bucket', 'delete_bucket'])(
  'E11: %s sanitizes an unavailable D1 and preserves rows',
  async (name) => {
    const db = await app.mf.getD1Database('DB');
    await db
      .prepare(
        "INSERT INTO buckets VALUES ('work', '2026-10-04T00:00:00.000Z')",
      )
      .run();
    const before = await snapshot();
    await db.prepare('ALTER TABLE buckets RENAME TO unavailable_buckets').run();
    try {
      expectToolError(
        await driver.call(name, { path: 'work' }),
        'Service unavailable. Try again later.',
      );
      expect(await snapshot('unavailable_buckets')).toEqual(before);
    } finally {
      await db
        .prepare('ALTER TABLE unavailable_buckets RENAME TO buckets')
        .run();
    }
  },
);

it.each(['absent', 'same', 'foreign'])(
  'E9: an owner request with %s Origin follows the MCP rule without CORS',
  async (origin) => {
    const headers = {
      'Cf-Access-Jwt-Assertion': await issuer.assertion(),
      ...(origin === 'absent'
        ? {}
        : { Origin: origin === 'same' ? app.origin : 'https://foreign.test' }),
    };
    const before = await snapshot();
    const request = mcpRequest(
      app.origin,
      '2026-07-28',
      'tools/call',
      {
        name: 'create_bucket',
        arguments: { path: 'work/x' },
      },
      headers,
    );
    const response = await fetch(request);
    expect(response.status).toBe(origin === 'foreign' ? 403 : 200);
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
    if (origin === 'foreign') expect(await snapshot()).toEqual(before);
    else
      expect((await snapshot()).map((row) => row.path)).toEqual([
        'me',
        'work',
        'work/x',
      ]);
  },
);
it.each(['GET', 'HEAD', 'DELETE', 'OPTIONS'])(
  'E9: a foreign Origin is rejected before MCP for %s too',
  async (method) => {
    const response = await fetch(`${app.origin}/mcp`, {
      method,
      headers: {
        Origin: 'https://foreign.test',
        'Cf-Access-Jwt-Assertion': await issuer.assertion(),
      },
    });
    expect(response.status).toBe(403);
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
    expect((await snapshot()).map((row) => row.path)).toEqual(['me']);
  },
);
it.each(['absent', 'other-owner', 'expired', 'wrong-audience'])(
  'E10: %s authentication wins over every Origin and never returns MCP',
  async (state) => {
    const claims: Record<string, unknown> = {};
    if (state === 'other-owner') claims.email = 'other@nook.test';
    if (state === 'expired') claims.exp = 1;
    if (state === 'wrong-audience') claims.aud = 'another-application';
    const headers: Record<string, string> =
      state === 'absent'
        ? {}
        : { 'Cf-Access-Jwt-Assertion': await issuer.assertion(claims) };
    for (const origin of [undefined, app.origin, 'https://foreign.test']) {
      const response = await fetch(
        mcpRequest(app.origin, '2026-07-28', 'tools/list', undefined, {
          ...headers,
          ...(origin ? { Origin: origin } : {}),
        }),
      );
      expect(response.status).toBe(state === 'other-owner' ? 403 : 401);
      expect(await response.json()).toEqual({
        _tag: state === 'other-owner' ? 'Forbidden' : 'Unauthorized',
      });
      expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
    }
  },
);
