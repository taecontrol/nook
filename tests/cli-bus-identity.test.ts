import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { approve, ownerRuntime } from './support/authorizations.ts';
import { privateKeyring, readUserCode } from './support/cli.ts';
import { expectOutput } from './support/private-assertions.ts';
import { runtime } from './support/runtime.ts';

// D-Bus GetId decides equivalence, so one alias that defeats string
// normalization and one multi-address fallback cover every address form.
it.each(['symlink', 'fallback'])(
  'equivalent private bus address %s still excludes overlapping logins',
  async (form) => {
    const app = await ownerRuntime(await runtime());
    const keyring = await privateKeyring();
    try {
      const hook = resolve(keyring.home, 'same-private-bus.mjs');
      await writeFile(
        hook,
        [
          "import { spawnSync } from 'node:child_process';",
          "import { symlinkSync } from 'node:fs';",
          "import { resolve } from 'node:path';",
          `import { testEnvironment } from ${JSON.stringify(resolve('scripts/lib/test-environment.ts'))};`,
          'const before = process.env.DBUS_SESSION_BUS_ADDRESS;',
          "if (!before?.startsWith('unix:path=') || !before.includes(',guid=')) throw new Error('Private bus alias unavailable');",
          'const path = decodeURIComponent(/^unix:path=([^,]+)/.exec(before)[1]);',
          "let after = before.replace(/,guid=[0-9a-f]+/, '');",
          `const form = ${JSON.stringify(form)};`,
          "if (form === 'symlink') { const alias = resolve(process.env.HOME, 'bus-alias'); symlinkSync(path, alias); after = 'unix:path=' + encodeURIComponent(alias); }",
          "if (form === 'fallback') after = 'unix:path=' + encodeURIComponent(resolve(process.env.HOME, 'missing-session-bus')) + ';' + before;",
          "if (after === before) throw new Error('Private bus alias unchanged');",
          "const id = address => { const env = testEnvironment(process.env.HOME); env.DBUS_SESSION_BUS_ADDRESS = address; return spawnSync('/usr/bin/dbus-send', ['--session', '--print-reply=literal', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.GetId'], { env, encoding: 'utf8' }); };",
          'const original = id(before); const equivalent = id(after);',
          "if (original.status !== 0 || equivalent.status !== 0 || !/^[a-f0-9]{32}$/.test(original.stdout.trim()) || original.stdout !== equivalent.stdout) throw new Error('A private equivalent bus is required');",
          'process.env.DBUS_SESSION_BUS_ADDRESS = after;',
          '',
        ].join('\n'),
      );
      const first = keyring.start(['login', app.origin]);
      const firstCode = await readUserCode(first);
      const second = keyring.start(['login', app.origin], {
        NODE_OPTIONS: `--import=${hook}`,
      });
      const secondResult = await second.done;
      expect(secondResult.status).toBe(1);
      expectOutput(
        secondResult.stdout + secondResult.stderr,
        'Another Nook session command is in progress. Finish it before starting a new one.',
      );
      expect((await approve(app, firstCode)).status).toBe(204);
      expect((await first.done).status).toBe(0);
      const credential = await keyring.lookup(app.origin);
      expect((await keyring.start(['logout']).done).status).toBe(0);
      expect(
        (
          await fetch(`${app.origin}/api/machine/whoami`, {
            headers: { authorization: `Bearer ${credential}` },
          })
        ).status,
      ).toBe(401);
    } finally {
      await keyring.close();
      await app.close();
    }
  },
  15000,
);
