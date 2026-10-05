import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { approve, ownerRuntime } from './support/authorizations.ts';
import { privateKeyring, readUserCode } from './support/cli.ts';
import { machineProxy } from './support/machine-proxy.ts';
import {
  configHasOnlyUrl,
  expectOutput,
} from './support/private-assertions.ts';
import { runtime } from './support/runtime.ts';

it('paired first-store and revocation failures restore both credential and configuration', async () => {
  const app = await ownerRuntime(await runtime());
  const keyring = await privateKeyring();
  let unavailable = true;
  const proxy = await machineProxy(app, ({ method }) =>
    method === 'DELETE' && unavailable ? 503 : undefined,
  );
  try {
    await writeFile(
      resolve(keyring.shim, 'secret-tool'),
      [
        '#!/bin/sh',
        'if [ "$1" = "store" ]; then',
        ' case "$2" in',
        '  "--label=Nook machine "*)',
        '   if [ ! -e "$HOME/fail-once" ]; then',
        '    /usr/bin/touch "$HOME/fail-once"',
        '    /usr/bin/cat >/dev/null',
        '    exit 2',
        '   fi',
        '  ;;',
        ' esac',
        'fi',
        'exec /usr/bin/secret-tool "$@"',
        '',
      ].join('\n'),
      { mode: 0o700 },
    );
    const child = keyring.start(['login', proxy.origin]);
    expect((await approve(app, await readUserCode(child))).status).toBe(204);
    expect((await child.done).status).toBe(1);
    const credentialPresent = Boolean(await keyring.lookup(proxy.origin));
    const configurationPresent = await configHasOnlyUrl(
      keyring.config,
      proxy.origin,
    );
    expect(
      credentialPresent,
      'The issued credential remains recoverable in Secret Service',
    ).toBe(true);
    expect(
      configurationPresent,
      'whoami and logout can find the recovered installation',
    ).toBe(true);
    expect((await keyring.start(['whoami']).done).status).toBe(0);
    unavailable = false;
    expect((await keyring.start(['logout']).done).status).toBe(0);
  } finally {
    await proxy.close();
    await keyring.close();
    await app.close();
  }
}, 18000);
it.each([2, 1])(
  'a silent lookup status %s fails instead of accepting an ambiguous credential result',
  async (status) => {
    const app = await ownerRuntime(await runtime());
    const keyring = await privateKeyring();
    try {
      const child = keyring.start(['login', app.origin]);
      expect((await approve(app, await readUserCode(child))).status).toBe(204);
      expect((await child.done).status).toBe(0);
      const before = await keyring.lookup(app.origin);
      await writeFile(
        resolve(keyring.shim, 'secret-tool'),
        `#!/bin/sh\nif [ "$1" = "lookup" ]; then /usr/bin/secret-tool "$@"${status === 2 ? ' >/dev/null' : ''}; exit ${status}; fi\nexec /usr/bin/secret-tool "$@"\n`,
        { mode: 0o700 },
      );
      const result = await keyring.start(['whoami']).done;
      expect(result.status).toBe(1);
      expectOutput(
        result.stdout + result.stderr,
        'Nook keeps its token in the Secret Service keyring and could not use it.',
      );
      expect((await keyring.lookup(app.origin)) === before).toBe(true);
    } finally {
      await keyring.close();
      await app.close();
    }
  },
  12000,
);
it('compensation clears a stored credential that has already been externally revoked', async () => {
  const app = await ownerRuntime(await runtime());
  const keyring = await privateKeyring();
  try {
    await writeFile(
      resolve(keyring.shim, 'secret-tool'),
      [
        '#!/bin/sh',
        'if [ "$1" = "store" ]; then',
        ' case "$2" in',
        '  "--label=Nook machine "*)',
        '   /usr/bin/secret-tool "$@"',
        '   /usr/bin/touch "$HOME/stored"',
        '   while [ ! -f "$HOME/release-store" ]; do /usr/bin/sleep 0.02; done',
        '   exit 0',
        '  ;;',
        ' esac',
        'fi',
        'exec /usr/bin/secret-tool "$@"',
        '',
      ].join('\n'),
      { mode: 0o700 },
    );
    const child = keyring.start(['login', app.origin]);
    const code = await readUserCode(child);
    await mkdir(keyring.config, { recursive: true });
    expect((await approve(app, code)).status).toBe(204);
    await expect
      .poll(() => existsSync(resolve(keyring.home, 'stored')))
      .toBe(true);
    await (await app.mf.getD1Database('DB'))
      .prepare('DELETE FROM machine_tokens')
      .run();
    await writeFile(resolve(keyring.home, 'release-store'), 'ready');
    expect((await child.done).status).toBe(1);
    expect(
      (await keyring.lookup(app.origin)) === '',
      'No revoked partial item survives compensation',
    ).toBe(true);
  } finally {
    await writeFile(resolve(keyring.home, 'release-store'), 'ready');
    await keyring.close();
    await app.close();
  }
}, 12000);
it('failed private bus setup removes only its temporary HOME', async () => {
  const directory = resolve('.review/failed-fixture');
  await mkdir(directory, { recursive: true });
  try {
    let rejected = false;
    try {
      const fixture = await privateKeyring('present', {
        nodeOptions: `--import=${resolve(directory, 'missing-import.mjs')}`,
        tempRoot: directory,
      });
      await fixture.close();
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect((await readdir(directory)).length).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 8000);
