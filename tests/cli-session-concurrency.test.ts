import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeEach, expect, it } from 'vitest';
import {
  approve,
  jsonRequest,
  ownerRuntime,
} from './support/authorizations.ts';
import {
  type PrivateKeyring,
  privateKeyring,
  readUserCode,
} from './support/cli.ts';
import { expectOutput } from './support/private-assertions.ts';
import { runtime, type TestRuntime } from './support/runtime.ts';

let app: TestRuntime;
let keyring: PrivateKeyring;
const busy =
  'Another Nook session command is in progress. Finish it before starting a new one.';
beforeEach(async () => {
  app = await ownerRuntime(await runtime());
  keyring = await privateKeyring();
  return async () => {
    await keyring.close();
    await app.close();
  };
});
async function count(table: 'authorizations' | 'machine_tokens') {
  return (
    await (
      await app.mf.getD1Database('DB')
    )
      .prepare(`SELECT count(*) AS count FROM ${table}`)
      .first()
  )?.count;
}
async function approvedLogin() {
  const child = keyring.start(['login', app.origin]);
  expect((await approve(app, await readUserCode(child))).status).toBe(204);
  expect((await child.done).status).toBe(0);
}
async function finishUnexpectedLogin(
  child: ReturnType<PrivateKeyring['start']>,
) {
  await expect.poll(() => child.output().length > 0).toBe(true);
  if (child.output().includes('Waiting for approval'))
    expect((await approve(app, await readUserCode(child))).status).toBe(204);
  return child.done;
}
it('a pending login rejects a second login sharing its keyring, even with another config directory', async () => {
  const first = keyring.start(['login', app.origin]);
  const code = await readUserCode(first);
  const second = keyring.start(['login', app.origin], {
    XDG_CONFIG_HOME: resolve(keyring.home, 'second-config'),
  });
  const secondResult = await finishUnexpectedLogin(second);
  expect(secondResult.status).toBe(1);
  expectOutput(secondResult.stdout + secondResult.stderr, busy, true);
  expect(await count('authorizations')).toBe(1);
  expect((await approve(app, code)).status).toBe(204);
  expect((await first.done).status).toBe(0);
  expect(await count('machine_tokens')).toBe(1);
  expect((await keyring.start(['logout']).done).status).toBe(0);
  expect(await count('machine_tokens')).toBe(0);
});
it('a logout waiting to clear its old item excludes a second logout and a replacement login', async () => {
  await approvedLogin();
  await writeFile(
    resolve(keyring.shim, 'secret-tool'),
    '#!/bin/sh\nif [ "$1" = "clear" ] && [ "$3" = "nook" ] && mkdir "$HOME/clear-held" 2>/dev/null; then\n while [ ! -f "$HOME/release-clear" ]; do sleep 0.02; done\nfi\nexec /usr/bin/secret-tool "$@"\n',
    { mode: 0o700 },
  );
  const first = keyring.start(['logout']);
  try {
    await expect
      .poll(() => existsSync(resolve(keyring.home, 'clear-held')))
      .toBe(true);
    const second = await keyring.start(['logout']).done;
    const replacement = await finishUnexpectedLogin(
      keyring.start(['login', app.origin]),
    );
    await writeFile(resolve(keyring.home, 'release-clear'), 'ready');
    expect((await first.done).status).toBe(0);
    for (const result of [second, replacement]) {
      expect(result.status).toBe(1);
      expectOutput(result.stdout + result.stderr, busy, true);
    }
    expect(await count('machine_tokens')).toBe(0);
    await approvedLogin();
    expect((await keyring.start(['logout']).done).status).toBe(0);
    expect(await count('machine_tokens')).toBe(0);
  } finally {
    await writeFile(resolve(keyring.home, 'release-clear'), 'ready');
  }
});
it('killing a pending login releases coordination without a stale file or active credential', async () => {
  const first = keyring.start(['login', app.origin]);
  await readUserCode(first);
  first.kill('SIGKILL');
  expect((await first.done).status).toBe(1);
  await approvedLogin();
  expect(await count('machine_tokens')).toBe(1);
  expect((await keyring.start(['logout']).done).status).toBe(0);
  expect(await count('machine_tokens')).toBe(0);
});
it('a denied login releases coordination for a later successful login', async () => {
  const first = keyring.start(['login', app.origin]);
  const code = await readUserCode(first);
  expect(
    (await jsonRequest(app, `/api/authorizations/${code}/deny`)).status,
  ).toBe(204);
  expect((await first.done).status).toBe(1);
  await approvedLogin();
  expect((await keyring.start(['logout']).done).status).toBe(0);
});
