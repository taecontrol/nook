import { createInterface } from 'node:readline';
import { Log, LogLevel } from 'miniflare';
import { beforeEach, expect, it } from 'vitest';
import { access, accessFixture } from './support/access.ts';
import { ownerRuntime } from './support/authorizations.ts';
import { checkpointRuntime } from './support/checkpoint-runtime.ts';
import {
  grantTree,
  issueGrant,
  machineMcp,
  seedGrantTree,
} from './support/grants.ts';
import {
  expectPrivate,
  listMachines,
  revokeMachine,
  tokenHash,
} from './support/machines.ts';
import {
  expectToolError,
  expectToolSuccess,
  mcpDriver,
  type ToolResult,
} from './support/mcp.ts';
import { runtime, type TestRuntime } from './support/runtime.ts';

let app: TestRuntime;
beforeEach(async () => {
  app = await ownerRuntime(await runtime());
  await seedGrantTree(app);
  return () => app.close();
});
async function paths() {
  return (
    await (
      await app.mf.getD1Database('DB')
    )
      .prepare('SELECT path FROM buckets ORDER BY path')
      .all<{ path: string }>()
  ).results.map((row) => row.path);
}
async function bucketRows() {
  return (
    await (
      await app.mf.getD1Database('DB')
    )
      .prepare('SELECT * FROM buckets ORDER BY path')
      .all()
  ).results;
}
function listed(result: ToolResult) {
  expect(result.structuredContent).toHaveProperty('buckets');
  return ((result.structuredContent?.buckets ?? []) as { path: string }[]).map(
    (bucket) => bucket.path,
  );
}
const forbidden = 'Access to this bucket is forbidden.';
it('E6: me and work expose exactly their subtrees and an outside creation writes nothing', async () => {
  const { token } = await issueGrant(app, ['me', 'work']);
  const driver = machineMcp(app, token);
  expect(listed(await driver.call('list_buckets'))).toEqual(
    grantTree.filter((path) => path === 'me' || path.startsWith('work')),
  );
  const before = await paths();
  expectToolError(
    await driver.call('create_bucket', { path: 'personal/x' }),
    forbidden,
  );
  expect(await paths()).toEqual(before);
});
it('E7/E10: a deep grant exposes me, ancestors and descendants, hiding siblings and prefix lookalikes', async () => {
  await seedGrantTree(app, ['work/acme-old', 'me/notes']);
  const { token } = await issueGrant(app, ['work/acme']);
  expect(listed(await machineMcp(app, token).call('list_buckets'))).toEqual([
    'me',
    'work',
    'work/acme',
    'work/acme/api',
    'work/acme/web',
  ]);
});
it('E8: all-bucket machine MCP has identical tool definitions and results to owner MCP', async () => {
  const { token } = await issueGrant(app);
  const machine = machineMcp(app, token);
  const owner = mcpDriver(app.origin);
  expect(await machine.listTools()).toEqual(await owner.listTools());
  expect(await machine.call('list_buckets')).toEqual(
    await owner.call('list_buckets'),
  );
  await owner.call('create_bucket', { path: 'work/new' });
  expect(await machine.call('create_bucket', { path: 'work/new' })).toEqual(
    await owner.call('create_bucket', { path: 'work/new' }),
  );
  expect(await machine.call('delete_bucket', { path: 'work/acme' })).toEqual(
    await owner.call('delete_bucket', { path: 'work/acme' }),
  );
});
it.each(['2026-07-28', '2025-06-18'] as const)(
  'E9: %s protocol survives a fresh isolate at every observed step',
  async (version) => {
    const { token } = await issueGrant(app, ['work']);
    const steps =
      version === '2026-07-28'
        ? ([
            ['server/discover', undefined],
            ['tools/list', undefined],
            ['tools/call', { name: 'list_buckets', arguments: {} }],
          ] as const)
        : ([
            [
              'initialize',
              {
                protocolVersion: version,
                capabilities: {},
                clientInfo: { name: 'codex-mcp-client', version: '0.160.0' },
              },
            ],
            ['notifications/initialized', undefined],
            ['tools/list', { _meta: { progressToken: 0 } }],
            ['tools/call', { name: 'list_buckets', arguments: {} }],
          ] as const);
    for (const [method, params] of steps) {
      await app.setBindings({
        LOCAL_OWNER: 'synthetic-owner',
        LOCAL_ORIGIN: app.origin,
      });
      const driver = machineMcp(app, token, version);
      if (method.startsWith('notifications/'))
        expect((await driver.request(method, params)).status).toBe(202);
      else {
        const result = await driver.result<Record<string, unknown>>(
          method,
          params,
        );
        if (method === 'tools/call')
          expect(result).toMatchObject({
            structuredContent: {
              buckets: expect.arrayContaining([
                { path: 'me', createdAt: expect.any(String) },
              ]),
            },
          });
        if (method === 'initialize')
          expect(result.protocolVersion).toBe(version);
        if (method === 'server/discover')
          expect(result.supportedVersions).toEqual(['2026-07-28']);
        if (method === 'tools/list') expect(result.tools).toHaveLength(6);
      }
    }
  },
);
it.each([
  'me',
  'work',
  'work/taecontrol',
  'work/acme-old',
  'personal',
  'personal/finances',
  'personal/new',
])(
  'E10: both writes deny %s without revealing existence or changing rows',
  async (path) => {
    await seedGrantTree(app, ['work/acme-old']);
    const { token } = await issueGrant(app, ['work/acme']);
    const driver = machineMcp(app, token);
    const before = await paths();
    const rowsBefore = await bucketRows();
    for (const tool of ['create_bucket', 'delete_bucket']) {
      expectToolError(await driver.call(tool, { path }), forbidden);
      expect(await paths()).toEqual(before);
      expect(await bucketRows()).toEqual(rowsBefore);
    }
  },
);
it('E10: grant-root and descendant writes preserve idempotency, nonempty and not-found errors', async () => {
  const { token } = await issueGrant(app, ['work/acme']);
  const driver = machineMcp(app, token);
  expectToolSuccess(await driver.call('create_bucket', { path: 'work/acme' }), {
    path: 'work/acme',
    created: false,
    createdAncestors: [],
  });
  expectToolSuccess(
    await driver.call('create_bucket', { path: 'work/acme/api' }),
    { path: 'work/acme/api', created: false, createdAncestors: [] },
  );
  expectToolError(
    await driver.call('delete_bucket', { path: 'work/acme' }),
    'Delete its child buckets first.',
  );
  expectToolError(
    await driver.call('delete_bucket', { path: 'work/acme/new' }),
    'Bucket not found.',
  );
  expectToolSuccess(
    await driver.call('create_bucket', { path: 'work/acme/new' }),
    { path: 'work/acme/new', created: true, createdAncestors: [] },
  );
  for (const path of [
    'work/acme/new',
    'work/acme/api',
    'work/acme/web',
    'work/acme',
  ])
    expectToolSuccess(await driver.call('delete_bucket', { path }), { path });
  for (const tool of ['create_bucket', 'delete_bucket'])
    expectToolError(
      await driver.call(tool, { path: 'Personal' }),
      'Use lowercase letters: personal',
    );
});
it('E11: explicitly granting me permits descendants but preserves the reserved bucket', async () => {
  const { token } = await issueGrant(app, ['me', 'work']);
  const driver = machineMcp(app, token);
  expectToolSuccess(await driver.call('create_bucket', { path: 'me/notes' }), {
    path: 'me/notes',
    created: true,
    createdAncestors: [],
  });
  expectToolError(
    await driver.call('delete_bucket', { path: 'me' }),
    'The me bucket cannot be deleted.',
  );
});
it('E12: recreating a granted subtree may restore structural ancestors without exposing personal', async () => {
  const { token } = await issueGrant(app, ['work/acme']);
  await (await app.mf.getD1Database('DB'))
    .prepare("DELETE FROM buckets WHERE path <> 'me' AND path <> 'personal'")
    .run();
  const driver = machineMcp(app, token);
  expectToolSuccess(
    await driver.call('create_bucket', { path: 'work/acme/x' }),
    {
      path: 'work/acme/x',
      created: true,
      createdAncestors: ['work', 'work/acme'],
    },
  );
  expect(listed(await driver.call('list_buckets'))).toEqual([
    'me',
    'work',
    'work/acme',
    'work/acme/x',
  ]);
});
it('E13/E14: missing, malformed, unknown, revoked, Access and synthetic-owner credentials never cross the route boundary', async () => {
  const issued = await issueGrant(app);
  const before = await paths();
  for (const token of [undefined, 'malformed', `nook_${'z'.repeat(43)}`])
    expect(
      (
        await machineMcp(app, token).request('tools/call', {
          name: 'create_bucket',
          arguments: { path: 'personal/attack' },
        })
      ).status,
    ).toBe(401);
  const issuer = await accessFixture();
  await app.setBindings(access, { outboundService: issuer.outboundService });
  expect(
    (
      await machineMcp(app, undefined, '2026-07-28', {
        'Cf-Access-Jwt-Assertion': await issuer.assertion(),
      }).request('tools/list')
    ).status,
  ).toBe(401);
  expect(
    (
      await mcpDriver(app.origin, '2026-07-28', {
        Authorization: `Bearer ${issued.token}`,
      }).request('tools/list')
    ).status,
  ).toBe(401);
  await ownerRuntime(app);
  expect(
    (await revokeMachine(app, (await listMachines(app))[0].id)).status,
  ).toBe(204);
  expect(
    (await machineMcp(app, issued.token).request('tools/list')).status,
  ).toBe(401);
  expect(await paths()).toEqual(before);
});
it('E15: all machine MCP methods reject foreign Origin before authentication or tools, accepting absent or own Origin', async () => {
  const { token } = await issueGrant(app);
  const before = await paths();
  for (const origin of [undefined, app.origin])
    expect(
      (
        await machineMcp(
          app,
          token,
          '2026-07-28',
          origin ? { Origin: origin } : {},
        ).listTools()
      ).tools,
    ).toHaveLength(6);
  for (const method of ['POST', 'GET', 'DELETE']) {
    const response = await fetch(`${app.origin}/api/machine/mcp`, {
      method,
      headers: {
        Origin: 'https://foreign.test',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      ...(method === 'POST'
        ? {
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name: 'create_bucket',
                arguments: { path: 'personal/attack' },
              },
            }),
          }
        : {}),
    });
    expect(response.status).toBe(403);
  }
  expect(await paths()).toEqual(before);
});
it('E15: foreign Origin runs no authentication statement for valid, unknown or absent credentials', async () => {
  const labels: string[] = [];
  const measured = await ownerRuntime(
    await checkpointRuntime(async (label) => {
      labels.push(label);
    }),
  );
  try {
    const { token } = await issueGrant(measured);
    for (const credential of [token, `nook_${'z'.repeat(43)}`, undefined]) {
      for (const method of ['POST', 'GET', 'DELETE', 'OPTIONS']) {
        labels.length = 0;
        const response = await fetch(`${measured.origin}/api/machine/mcp`, {
          method,
          headers: {
            Origin: 'https://foreign.test',
            ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
            'Content-Type': 'application/json',
          },
          ...(method === 'POST'
            ? {
                body: JSON.stringify({
                  jsonrpc: '2.0',
                  id: 1,
                  method: 'tools/list',
                }),
              }
            : {}),
        });
        expect(response.status).toBe(403);
        expect(labels).toEqual([]);
        expect((await listMachines(measured))[0].lastUsedAt).toBeNull();
      }
    }
  } finally {
    await measured.close();
  }
});
it('E17: machine MCP authentication records last use in one statement before the owner tool statements', async () => {
  const labels: string[] = [];
  const measured = await ownerRuntime(
    await checkpointRuntime(async (label) => {
      labels.push(label);
    }),
  );
  try {
    const { token } = await issueGrant(measured);
    labels.length = 0;
    await machineMcp(measured, token).call('list_buckets');
    expect(labels).toEqual(['/machine-write', '/machine-read']);
    expect((await listMachines(measured))[0].lastUsedAt).not.toBeNull();
  } finally {
    await measured.close();
  }
});
class PrivateLog extends Log {
  messages: string[] = [];
  constructor() {
    super(LogLevel.VERBOSE);
  }
  protected log(message: string) {
    this.messages.push(message);
  }
}
it('E18: responses and runtime logs exclude credentials even when genuine D1 failures echo the hash', async () => {
  const log = new PrivateLog();
  await app.setBindings(
    { LOCAL_OWNER: 'synthetic-owner', LOCAL_ORIGIN: app.origin },
    {
      log,
      handleRuntimeStdio: (stdout, stderr) => {
        for (const input of [stdout, stderr])
          createInterface({ input }).on('line', (line) =>
            log.messages.push(line),
          );
      },
    },
  );
  const { token } = await issueGrant(app, ['work']);
  const hash = await tokenHash(app, token);
  const driver = machineMcp(app, token);
  expectPrivate(JSON.stringify(await driver.call('list_buckets')), [
    token,
    hash,
  ]);
  expectPrivate(
    JSON.stringify(await driver.call('create_bucket', { path: 'personal/x' })),
    [token, hash],
  );
  const db = await app.mf.getD1Database('DB');
  await db
    .prepare(
      `CREATE TRIGGER fail_bucket BEFORE INSERT ON buckets BEGIN SELECT RAISE(ABORT, '${hash}'); END`,
    )
    .run();
  const result = await driver.call('create_bucket', { path: 'work/new' });
  expectToolError(result, 'Service unavailable. Try again later.');
  expectPrivate(JSON.stringify(result), [token, hash]);
  await db
    .prepare(
      `CREATE TRIGGER fail_auth BEFORE UPDATE ON machine_tokens BEGIN SELECT RAISE(ABORT, '${hash}'); END`,
    )
    .run();
  const response = await driver.request('tools/list');
  expect(response.status).toBe(503);
  expectPrivate(await response.text(), [token, hash]);
  expectPrivate(log.messages.join('\n'), [token, hash]);
});
