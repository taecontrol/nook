import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { approve, ownerRuntime } from './support/authorizations.ts';
import { privateKeyring, readUserCode } from './support/cli.ts';
import { runtime } from './support/runtime.ts';

it.each([
  'without-guid',
  'escaped-path',
  'symlink',
  'fallback',
  'reordered-fields',
])(
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
          "if (form === 'escaped-path') after = 'unix:path=' + [...Buffer.from(path)].map(byte => '%' + byte.toString(16).padStart(2, '0')).join('');",
          "if (form === 'symlink') { const alias = resolve(process.env.HOME, 'bus-alias'); symlinkSync(path, alias); after = 'unix:path=' + encodeURIComponent(alias); }",
          "if (form === 'fallback') after = 'unix:path=' + encodeURIComponent(resolve(process.env.HOME, 'missing-session-bus')) + ';' + before;",
          "if (form === 'reordered-fields') after = 'unix:' + before.slice(5).split(',').reverse().join(',');",
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
      await expect.poll(() => second.output().length > 0).toBe(true);
      let secondCode: string | undefined;
      if (second.output().includes('Waiting for approval'))
        secondCode = await readUserCode(second);
      expect((await approve(app, firstCode)).status).toBe(204);
      const firstResult = await first.done;
      const firstCredential = await keyring.lookup(app.origin);
      if (secondCode) expect((await approve(app, secondCode)).status).toBe(204);
      const secondResult = await second.done;
      const replacementCredential = await keyring.lookup(app.origin);
      const db = await app.mf.getD1Database('DB');
      const count = async () =>
        (
          await db
            .prepare('SELECT count(*) AS count FROM machine_tokens')
            .first()
        )?.count;
      const countBeforeLogout = await count();
      const beforeStatus = (
        await fetch(`${app.origin}/api/machine/whoami`, {
          headers: { authorization: `Bearer ${firstCredential}` },
        })
      ).status;
      const logout = await keyring.start(['logout']).done;
      const afterStatus = (
        await fetch(`${app.origin}/api/machine/whoami`, {
          headers: { authorization: `Bearer ${firstCredential}` },
        })
      ).status;
      const observation = {
        firstSucceeded: firstResult.status === 0,
        secondSucceeded: secondResult.status === 0,
        secondStartedRequest: secondCode !== undefined,
        credentialReplaced: firstCredential !== replacementCredential,
        displacedIdentityStatusBeforeLogout: beforeStatus,
        logoutSucceeded: logout.status === 0,
        keyringEmptyAfterLogout: (await keyring.lookup(app.origin)) === '',
        displacedIdentityStatusAfterLogout: afterStatus,
        activeRowsBeforeLogout: countBeforeLogout,
        activeRowsAfterLogout: await count(),
      };
      expect(secondResult.status).toBe(1);
      expect(observation.displacedIdentityStatusAfterLogout).toBe(401);
    } finally {
      await keyring.close();
      await app.close();
    }
  },
  15000,
);
