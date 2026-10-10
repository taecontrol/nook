import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { BucketGrant } from '@nook/contract';
import { beforeEach, expect, it } from 'vitest';
import { ownerRuntime } from './support/authorizations.ts';
import {
  filesContain,
  type PrivateKeyring,
  privateKeyring,
  readUserCode,
} from './support/cli.ts';
import {
  approveGrant,
  issueGrant,
  machineMcp,
  seedGrantTree,
} from './support/grants.ts';
import { machineProxy } from './support/machine-proxy.ts';
import { expectPrivate, listMachines } from './support/machines.ts';
import { runtime, type TestRuntime } from './support/runtime.ts';

let app: TestRuntime;
let keyring: PrivateKeyring;
beforeEach(async () => {
  app = await ownerRuntime(await runtime());
  await seedGrantTree(app);
  keyring = await privateKeyring();
  return async () => {
    await keyring.close();
    await app.close();
  };
});
async function login(grant: BucketGrant) {
  const child = keyring.start(['login', app.origin]);
  expect(
    (await approveGrant(app, await readUserCode(child), grant)).status,
  ).toBe(204);
  const result = await child.done;
  expect(result.status).toBe(0);
  expect(
    result.stdout.includes(
      `Logged in to ${app.origin} as work-laptop. Token stored in the system keyring.`,
    ),
  ).toBe(true);
}
it('E19/E22: mcp-header emits exactly one JSON line from the private keyring, makes no server request and creates no plaintext file', async () => {
  await login(['me', 'work']);
  const token = await keyring.lookup(app.origin);
  expect((await listMachines(app))[0].lastUsedAt).toBeNull();
  const result = await keyring.start(['mcp-header']).done;
  expect(result.status).toBe(0);
  expect(result.stderr === '', 'Header diagnostics are empty').toBe(true);
  expect(
    result.stdout ===
      `${JSON.stringify({ Authorization: `Bearer ${token}` })}\n`,
    'Only one headers JSON line is emitted',
  ).toBe(true);
  expect((await listMachines(app))[0].lastUsedAt).toBeNull();
  const headers = JSON.parse(result.stdout) as Record<string, string>;
  expect(
    (await machineMcp(app, undefined, '2026-07-28', headers).listTools()).tools,
  ).toHaveLength(6);
  expect(
    await filesContain(keyring.home, token),
    'No token is written under temporary HOME',
  ).toBe(false);
  await writeFile(
    keyring.config,
    JSON.stringify({ url: 'http://127.0.0.1:1' }),
  );
  expect(await keyring.store('http://127.0.0.1:1', token)).toBe(0);
  const offline = await keyring.start(['mcp-header']).done;
  expect(offline.status).toBe(0);
  expect(
    offline.stdout === result.stdout,
    'Headers work without contacting the installation',
  ).toBe(true);
});
it('E19: mcp-header makes zero HTTP requests, including unauthenticated requests whose errors could be ignored', async () => {
  let requests = 0;
  const proxy = await machineProxy(app, () => {
    requests++;
    return undefined;
  });
  try {
    const { token } = await issueGrant(app, ['work']);
    expect(await keyring.store(proxy.origin, token)).toBe(0);
    await mkdir(dirname(keyring.config), { recursive: true });
    await writeFile(keyring.config, JSON.stringify({ url: proxy.origin }));
    expect((await keyring.start(['mcp-header']).done).status).toBe(0);
    expect(requests).toBe(0);
  } finally {
    await proxy.close();
  }
});
it('E20: a stalled keyring returns empty stdout and login guidance before the MCP client deadline', async () => {
  await mkdir(dirname(keyring.config), { recursive: true });
  await writeFile(keyring.config, JSON.stringify({ url: app.origin }));
  await writeFile(
    resolve(
      keyring.shim,
      process.platform === 'darwin' ? 'security' : 'secret-tool',
    ),
    '#!/bin/sh\nsleep 60\n',
    { mode: 0o700 },
  );
  const started = performance.now();
  const result = await keyring.start(['mcp-header']).done;
  expect(result.status).toBe(1);
  expect(result.stdout === '', 'A stalled helper emits no headers').toBe(true);
  expect(
    result.stderr === `Not logged in. Run: nook login ${app.origin}\n`,
    'Exact login guidance without private diagnostics',
  ).toBe(true);
  expect(performance.now() - started).toBeLessThan(9000);
});
it.each(['unconfigured', 'missing-token', 'keyring-unavailable'] as const)(
  'E20: %s prints only login guidance to stderr and exits one',
  async (state) => {
    await mkdir(dirname(keyring.config), { recursive: true });
    if (state !== 'unconfigured')
      await writeFile(keyring.config, JSON.stringify({ url: app.origin }));
    if (state === 'keyring-unavailable') {
      await keyring.close();
      keyring = await privateKeyring('absent');
      await mkdir(dirname(keyring.config), { recursive: true });
      await writeFile(keyring.config, JSON.stringify({ url: app.origin }));
    }
    const result = await keyring.start(['mcp-header']).done;
    expect(result.status).toBe(1);
    expect(result.stdout === '', 'A failed helper must emit no headers').toBe(
      true,
    );
    expect(
      result.stderr ===
        `Not logged in. Run: nook login ${state === 'unconfigured' ? '<your Nook URL>' : app.origin}\n`,
      'Exact login guidance without private diagnostics',
    ).toBe(true);
  },
);
it.each([
  { grant: 'all', access: 'Access: all buckets (current and future)' },
  {
    grant: ['me', 'work'],
    access:
      'Access: me, work (read/write, including current and future descendants)\nRead only: none\nAll other buckets: hidden',
  },
  {
    grant: ['work/acme'],
    access:
      'Access: work/acme (read/write, including current and future descendants)\nRead only: me, work\nAll other buckets: hidden',
  },
] satisfies { grant: BucketGrant; access: string }[])(
  'E21: whoami describes $grant exactly and login keeps its success line',
  async ({ grant, access }) => {
    await login(grant);
    const result = await keyring.start(['whoami']).done;
    expect(result.status).toBe(0);
    expect(
      result.stdout === `work-laptop at ${app.origin}\n${access}\n`,
      'Exact public identity without private output',
    ).toBe(true);
    expectPrivate(result.stdout + result.stderr, [
      await keyring.lookup(app.origin),
    ]);
  },
);
