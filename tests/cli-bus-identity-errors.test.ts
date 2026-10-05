import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { ownerRuntime } from './support/authorizations.ts';
import { privateKeyring } from './support/cli.ts';
import { expectOutput } from './support/private-assertions.ts';
import { runtime } from './support/runtime.ts';

it.each([
  [
    'a valid bus identity with unsuccessful exit',
    '/usr/bin/dbus-send "$@"; exit 2',
  ],
  [
    'a malformed successful bus identity',
    'printf "not-a-bus-identity\\n"; exit 0',
  ],
  ['an unavailable identity command', undefined],
  ['a stalled identity command', 'exec /usr/bin/sleep 30'],
] as const)(
  'login rejects %s before creating any request',
  async (_name, script) => {
    const app = await ownerRuntime(await runtime());
    const keyring = await privateKeyring();
    try {
      if (script === undefined) await rm(resolve(keyring.shim, 'dbus-send'));
      else
        await writeFile(
          resolve(keyring.shim, 'dbus-send'),
          `#!/bin/sh\n${script}\n`,
          { mode: 0o700 },
        );
      const child = await keyring.start(['login', app.origin], {
        PATH: keyring.shim,
      }).done;
      expect(child.status).toBe(1);
      expectOutput(
        child.stdout + child.stderr,
        'Nook keeps its token in the Secret Service keyring and could not use it.',
      );
      const db = await app.mf.getD1Database('DB');
      expect(
        (
          await db
            .prepare('SELECT count(*) AS count FROM authorizations')
            .first()
        )?.count,
      ).toBe(0);
      expect(existsSync(keyring.config)).toBe(false);
      expect((await keyring.lookup(app.origin)) === '').toBe(true);
    } finally {
      await keyring.close();
      await app.close();
    }
  },
  18000,
);
