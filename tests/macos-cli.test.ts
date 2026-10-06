import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  killOrphans,
  orphanedProcesses,
  readHostProcess,
  snapshotProcesses,
} from '../scripts/lib/host-processes.ts';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import {
  approve,
  createAuthorization,
  jsonRequest,
  ownerRuntime,
} from './support/authorizations.ts';
import { closeBrowserPage } from './support/buckets-browser.ts';
import { filesContain, readUserCode } from './support/cli.ts';
import { machineProxy } from './support/machine-proxy.ts';
import {
  type CommandResult,
  type PrivateMacKeychain,
  privateMacKeychain,
  securityShim,
} from './support/macos-keychain.ts';
import { registeredMacProcessGroups } from './support/macos-process-journal.ts';
import {
  configHasOnlyUrl,
  expectOutput,
  waitingOutput,
} from './support/private-assertions.ts';
import { runtime, type TestRuntime } from './support/runtime.ts';

describe.runIf(process.platform === 'darwin')(
  'macOS CLI with a real temporary login Keychain',
  () => {
    let app: TestRuntime;
    let keyring: PrivateMacKeychain;
    let browser: Browser;
    let closeBrowser: (() => Promise<void>) | undefined;
    const keychainMessage =
      'Nook keeps its token in the macOS login keychain and could not use it. Unlock your login keychain and try again.';
    const busy =
      'Another Nook session command is in progress. Finish it before starting a new one.';
    beforeAll(async () => {
      ({ browser, close: closeBrowser } = await launchTestBrowser());
    });
    afterAll(async () => {
      await closeBrowser?.();
    });
    beforeEach(async () => {
      app = await ownerRuntime(await runtime());
      keyring = await privateMacKeychain();
      return async () => {
        await keyring.close();
        await app.close();
      };
    });
    async function login(name = 'macbook', origin = app.origin) {
      const child = keyring.start(['login', origin]);
      expect((await approve(app, await readUserCode(child), name)).status).toBe(
        204,
      );
      const result = await child.done;
      expect(result.status).toBe(0);
      return result;
    }
    async function count(table = 'authorizations') {
      return (
        await (
          await app.mf.getD1Database('DB')
        )
          .prepare(`SELECT count(*) AS count FROM ${table}`)
          .first()
      )?.count;
    }
    async function privateOutput(token: string, results: CommandResult[]) {
      expect(Boolean(token), 'The real keychain holds a credential').toBe(true);
      for (const result of results)
        expect(
          (result.stdout + result.stderr).includes(token),
          'Command diagnostics do not disclose credentials',
        ).toBe(false);
      expect(
        await filesContain(keyring.home, token),
        'No plaintext token in HOME, including recorded security/open argv',
      ).toBe(false);
    }
    async function shim(text: string) {
      await writeFile(resolve(keyring.shim, 'security'), text, { mode: 0o700 });
    }
    it('E1/E5: Chromium approval stores a generic nook password and whoami prints the machine grant privately', async () => {
      const child = keyring.start(['login', app.origin]);
      const code = await readUserCode(child);
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await page.goto(`${app.origin}/cli/authorize`);
        await page
          .getByRole('textbox', { name: 'Code from your terminal' })
          .fill(code);
        await page
          .getByRole('button', { name: 'Continue', exact: true })
          .click();
        const name = page.getByRole('textbox', {
          name: 'Machine name',
          exact: true,
        });
        await name.fill('macbook');
        await name.press('Enter');
        await page
          .getByRole('heading', { name: 'Machine approved', exact: true })
          .waitFor();
        const screenshots = resolve('.local/verification/screenshots');
        await mkdir(screenshots, { recursive: true });
        await page.screenshot({
          path: resolve(screenshots, 'macos-cli-approved.png'),
        });
        const loggedIn = await child.done;
        expect(loggedIn.status).toBe(0);
        expectOutput(
          loggedIn.stdout,
          `${waitingOutput(app.origin, code)}\nLogged in to ${app.origin} as macbook. Token stored in the system keyring.`,
          true,
        );
        const token = await keyring.lookup(app.origin);
        expect(
          /^nook_[A-Za-z0-9_-]{43}$/.test(token),
          'A machine token lives in the real keychain',
        ).toBe(true);
        const item = await keyring.inspect(app.origin);
        expect(item.status).toBe(0);
        expect((await keyring.inspectService('nook-check')).status).toBe(44);
        expectOutput(item.stdout, '"svce"<blob>="nook"');
        expectOutput(item.stdout, `"acct"<blob>="${app.origin}"`);
        const identity = await keyring.start(['whoami']).done;
        expect(identity.status).toBe(0);
        expectOutput(
          identity.stdout,
          `macbook at ${app.origin}\nAccess: me (read/write, including current and future descendants)\nRead only: none\nAll other buckets: hidden`,
          true,
        );
        expect(await configHasOnlyUrl(keyring.config, app.origin)).toBe(true);
        await privateOutput(token, [loggedIn, identity]);
      } finally {
        await closeBrowserPage(page, context);
      }
    });
    it('E2/E5: mcp-header emits exactly one bearer JSON line and makes zero HTTP requests', async () => {
      let requests = 0;
      const proxy = await machineProxy(app, () => {
        requests++;
        return undefined;
      });
      try {
        await login('macbook', proxy.origin);
        const token = await keyring.lookup(proxy.origin);
        requests = 0;
        const result = await keyring.start(['mcp-header']).done;
        expect(result.status).toBe(0);
        expect(
          result.stderr === '',
          'The header helper emits no diagnostics',
        ).toBe(true);
        expect(
          result.stdout ===
            `${JSON.stringify({ Authorization: `Bearer ${token}` })}\n`,
          'Exactly one header JSON line',
        ).toBe(true);
        expect(requests).toBe(0);
        expect(
          await filesContain(keyring.home, token),
          'Headers never persist a plaintext credential',
        ).toBe(false);
      } finally {
        await proxy.close();
      }
    });
    it('E3/E5: logout revokes and clears the credential, keeps only the URL, and whoami gives login guidance', async () => {
      const loggedIn = await login();
      const token = await keyring.lookup(app.origin);
      const loggedOut = await keyring.start(['logout']).done;
      expect(loggedOut.status).toBe(0);
      expectOutput(
        loggedOut.stdout,
        `Logged out of ${app.origin}. The token was revoked and removed from the keyring.`,
        true,
      );
      expect(
        (
          await fetch(`${app.origin}/api/machine/whoami`, {
            headers: { Authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(401);
      expect((await keyring.inspect(app.origin)).status).toBe(44);
      expect(await configHasOnlyUrl(keyring.config, app.origin)).toBe(true);
      const identity = await keyring.start(['whoami']).done;
      expect(identity.status).toBe(1);
      expectOutput(
        identity.stdout + identity.stderr,
        `Not logged in. Run: nook login ${app.origin}`,
        true,
      );
      await privateOutput(token, [loggedIn, loggedOut, identity]);
    });
    it.each(['macbook', 'Estación "Ñ" \\ 1'])(
      'E4/E5: machine label %s survives a second login without replacement or a new request',
      async (name) => {
        const first = await login(name);
        const token = await keyring.lookup(app.origin);
        const second = await keyring.start(['login', app.origin]).done;
        expect(second.status).toBe(1);
        expectOutput(
          second.stdout + second.stderr,
          `Already logged in to ${app.origin} as ${name}. Run: nook logout`,
          true,
        );
        expect(await count()).toBe(0);
        expect(
          (await keyring.lookup(app.origin)) === token,
          'Existing credential is unchanged',
        ).toBe(true);
        await privateOutput(token, [first, second]);
      },
    );
    it('E6: security echoing store stdin to stderr cannot expose a token', async () => {
      await shim(
        '#!/bin/sh\nif [ "$1" = "-i" ]; then\n nook_fixture_input="$(/bin/cat)"\n printf "%s" "$nook_fixture_input" >&2\n printf "%s\\n" "$nook_fixture_input" | /usr/bin/security "$@"\n exit $?\nfi\nexec /usr/bin/security "$@"\n',
      );
      const result = await login();
      await privateOutput(await keyring.lookup(app.origin), [result]);
    });
    it.each(['missing', 'failing'] as const)(
      'E7: security %s fails before authorization or configuration',
      async (mode) => {
        if (mode === 'missing')
          await rename(
            resolve(keyring.shim, 'security'),
            resolve(keyring.shim, 'disabled-security'),
          );
        else await shim('#!/bin/sh\nexit 2\n');
        const result = await keyring.start(['login', app.origin], {
          PATH: keyring.shim,
        }).done;
        expect(result.status).toBe(1);
        expectOutput(result.stdout + result.stderr, keychainMessage, true);
        expect(await count()).toBe(0);
        expect(existsSync(keyring.config)).toBe(false);
      },
    );
    it.each([
      'failed-read',
      'empty-read',
      'failed-metadata',
      'wrong-prefix',
      'wrong-type',
      'missing-label',
    ] as const)(
      'E7: %s fails privately and keeps the existing credential',
      async (mode) => {
        await login();
        const token = await keyring.lookup(app.origin);
        const metadata =
          mode.includes('metadata') ||
          mode === 'wrong-prefix' ||
          mode === 'wrong-type' ||
          mode === 'missing-label';
        const label =
          mode === 'wrong-prefix'
            ? 'Fake machine "macbook"'
            : mode === 'wrong-type'
              ? 'Nook machine 123'
              : 'Nook machine "macbook"';
        const output = metadata
          ? mode === 'missing-label'
            ? 'no label'
            : `    0x00000007 <blob>="${label}"\n`
          : mode === 'failed-read'
            ? 'synthetic diagnostic'
            : '';
        const encoded = Buffer.from(output).toString('base64');
        await shim(
          `#!/bin/sh\nif [ "$1" = "find-generic-password" ] && [ "$3" = "nook" ]${metadata ? ' && [ "$#" = 5 ]' : ' && [ "$#" = 6 ]'}; then\n printf "%s" "${encoded}" | /usr/bin/base64 -D\n exit ${mode.startsWith('failed') ? '2' : '0'}\nfi\nexec /usr/bin/security "$@"\n`,
        );
        const failed = await keyring.start(
          metadata ? ['login', app.origin] : ['whoami'],
        ).done;
        expect(failed.status).toBe(1);
        expectOutput(failed.stdout + failed.stderr, keychainMessage, true);
        expect((await keyring.lookup(app.origin)) === token).toBe(true);
        expect(await count()).toBe(0);
        await privateOutput(token, [failed]);
      },
    );
    it('E3: logout treats an already absent credential delete as successful', async () => {
      await login();
      await shim(
        '#!/bin/sh\nif [ "$1" = "delete-generic-password" ] && [ "$3" = "nook" ]; then exit 44; fi\nexec /usr/bin/security "$@"\n',
      );
      const result = await keyring.start(['logout']).done;
      expect(result.status).toBe(0);
      expectOutput(
        result.stdout,
        `Logged out of ${app.origin}. The token was revoked and removed from the keyring.`,
        true,
      );
      expect(await count('machine_tokens')).toBe(0);
    });
    it.each(['before-store', 'partial-store'] as const)(
      'E8: a %s failure revokes the issued token and clears any partial item',
      async (mode) => {
        let issued = '';
        const proxy = await machineProxy(
          app,
          () => undefined,
          async (response, request) => {
            if (
              request.path === '/api/machine/token' &&
              response.status === 200
            )
              issued = (await response.json()).token;
          },
        );
        try {
          const child = keyring.start(['login', proxy.origin]);
          const code = await readUserCode(child);
          await shim(
            `#!/bin/sh\nif [ "$1" = "-i" ]; then\n ${mode === 'partial-store' ? '/usr/bin/security "$@"' : '/bin/cat >/dev/null'}\n exit 2\nfi\nexec /usr/bin/security "$@"\n`,
          );
          expect((await approve(app, code)).status).toBe(204);
          const result = await child.done;
          expect(result.status).toBe(1);
          expectOutput(result.stdout + result.stderr, keychainMessage);
          expect(
            Boolean(issued),
            'The real Worker issued a credential before persistence failed',
          ).toBe(true);
          expect(
            (
              await fetch(`${app.origin}/api/machine/whoami`, {
                headers: { Authorization: `Bearer ${issued}` },
              })
            ).status,
          ).toBe(401);
          expect((await keyring.inspect(proxy.origin)).status).toBe(44);
          expect(await count('machine_tokens')).toBe(0);
          await privateOutput(issued, [result]);
        } finally {
          await proxy.close();
        }
      },
    );
    it.each(['denied', 'expired', 'pending-cap'] as const)(
      'E9: %s stores no credential',
      async (mode) => {
        if (mode === 'pending-cap')
          for (let i = 0; i < 20; i++) await createAuthorization(app);
        const child = keyring.start(['login', app.origin]);
        let message =
          'Too many pending login requests. Wait a few minutes and try again.';
        if (mode !== 'pending-cap') {
          const code = await readUserCode(child);
          if (mode === 'denied') {
            expect(
              (await jsonRequest(app, `/api/authorizations/${code}/deny`))
                .status,
            ).toBe(204);
            message = 'Login denied. Nothing was stored.';
          } else {
            await (await app.mf.getD1Database('DB'))
              .prepare('UPDATE authorizations SET expires_at=0')
              .run();
            message = `The login request expired. Run: nook login ${app.origin}`;
          }
        }
        const result = await child.done;
        expect(result.status).toBe(1);
        expectOutput(result.stdout + result.stderr, message);
        expect((await keyring.inspect(app.origin)).status).toBe(44);
        expect(existsSync(keyring.config)).toBe(false);
      },
    );
    it.each(['login', 'whoami', 'logout'] as const)(
      'E10: %s succeeds after a 15-second security stall',
      async (command) => {
        if (command !== 'login') await login();
        await shim(
          '#!/bin/sh\nif /bin/mkdir "$HOME/stall-once" 2>/dev/null; then /bin/sleep 15; fi\nexec /usr/bin/security "$@"\n',
        );
        const started = performance.now();
        const child = keyring.start(
          command === 'login' ? ['login', app.origin] : [command],
        );
        if (command === 'login')
          expect(
            (await approve(app, await readUserCodeWithLongProbe(child))).status,
          ).toBe(204);
        expect((await child.done).status).toBe(0);
        expect(performance.now() - started).toBeGreaterThanOrEqual(15_000);
      },
      30_000,
    );
    it('E11: mcp-header abandons a stalled shim in five seconds with empty stdout and login guidance', async () => {
      await login();
      const token = await keyring.lookup(app.origin);
      await shim('#!/bin/sh\nexec /bin/sleep 300\n');
      const started = performance.now();
      const result = await keyring.start(['mcp-header']).done;
      expect(result.status).toBe(1);
      expect(result.stdout === '', 'A stalled helper emits no headers').toBe(
        true,
      );
      expectOutput(
        result.stderr,
        `Not logged in. Run: nook login ${app.origin}`,
        true,
      );
      expect(performance.now() - started).toBeGreaterThanOrEqual(5000);
      expect(performance.now() - started).toBeLessThan(9000);
      expect(
        (await keyring.lookup(app.origin)) === token,
        'Timeout preserves the credential',
      ).toBe(true);
    });
    it.each(['success', 'failure', 'missing'] as const)(
      'E12: open %s receives only the code-free approval URL and login continues',
      async (mode) => {
        if (mode === 'missing')
          await rename(
            resolve(keyring.shim, 'open'),
            resolve(keyring.shim, 'disabled-open'),
          );
        const child = keyring.start(['login', app.origin], {
          PATH: keyring.shim,
          NOOK_TEST_OPEN_STATUS: mode === 'failure' ? '1' : '0',
        });
        const code = await readUserCode(child);
        if (mode !== 'missing') {
          await expect
            .poll(() => existsSync(resolve(keyring.home, 'opened')))
            .toBe(true);
          expect(
            (await readFile(resolve(keyring.home, 'opened'), 'utf8')).trim() ===
              `${app.origin}/cli/authorize`,
            'open receives only the approval URL',
          ).toBe(true);
        }
        expect((await approve(app, code)).status).toBe(204);
        expect((await child.done).status).toBe(0);
      },
    );
    it.each(['login', 'logout'] as const)(
      'E13: a pending login excludes %s from another config directory',
      async (command) => {
        const first = keyring.start(['login', app.origin]);
        const code = await readUserCode(first);
        const second = await keyring.start(
          command === 'login' ? ['login', app.origin] : [command],
          { XDG_CONFIG_HOME: resolve(keyring.home, 'second-config') },
        ).done;
        expect(second.status).toBe(1);
        expectOutput(second.stdout + second.stderr, busy, true);
        expect(await count()).toBe(1);
        expect((await approve(app, code)).status).toBe(204);
        expect((await first.done).status).toBe(0);
        const token = await keyring.lookup(app.origin);
        expect(
          (
            await readFile(
              resolve(
                keyring.home,
                'Library/Application Support/nook/session.lock',
              ),
            )
          ).length,
        ).toBe(0);
        await privateOutput(token, [second]);
      },
    );
    it('E13: a lock setup failure returns the protection message before authorization', async () => {
      await writeFile(
        resolve(keyring.home, 'Library/Application Support'),
        'synthetic obstruction',
      );
      const failed = await keyring.start(['login', app.origin]).done;
      expect(failed.status).toBe(1);
      expectOutput(
        failed.stdout + failed.stderr,
        'Could not protect the Nook session. Try again.',
        true,
      );
      expect(await count()).toBe(0);
    });
    it.each(['SIGKILL', 'denial'] as const)(
      'E14: %s releases the session lock for the next login',
      async (mode) => {
        const first = keyring.start(['login', app.origin]);
        const code = await readUserCode(first);
        if (mode === 'SIGKILL') {
          await expect
            .poll(() => existsSync(resolve(keyring.home, 'opened')))
            .toBe(true);
          const groups = await registeredMacProcessGroups(
            resolve(keyring.home, 'fixture-process-groups'),
          );
          await expect
            .poll(async () =>
              (await snapshotProcesses()).some(
                (item) =>
                  item.pid !== first.child.pid &&
                  groups.some((record) => record.group === item.group),
              ),
            )
            .toBe(false);
          first.kill('SIGKILL');
        } else
          expect(
            (await jsonRequest(app, `/api/authorizations/${code}/deny`)).status,
          ).toBe(204);
        expect((await first.done).status).toBe(1);
        await login();
        const token = await keyring.lookup(app.origin);
        expect(
          (
            await readFile(
              resolve(
                keyring.home,
                'Library/Application Support/nook/session.lock',
              ),
            )
          ).length,
        ).toBe(0);
        expect(
          await filesContain(keyring.home, token),
          'The lock and HOME never contain the credential',
        ).toBe(false);
      },
    );
    it('a failed clear retains the credential until logout can finish after revocation', async () => {
      await login();
      const token = await keyring.lookup(app.origin);
      await shim(
        '#!/bin/sh\nif [ "$1" = "delete-generic-password" ] && [ "$3" = "nook" ]; then exit 2; fi\nexec /usr/bin/security "$@"\n',
      );
      const failed = await keyring.start(['logout']).done;
      expect(failed.status).toBe(1);
      expectOutput(failed.stdout + failed.stderr, keychainMessage, true);
      expect(
        (await keyring.lookup(app.origin)) === token,
        'A failed clear retains the local credential',
      ).toBe(true);
      await shim(securityShim);
      expect((await keyring.start(['logout']).done).status).toBe(0);
      expect((await keyring.inspect(app.origin)).status).toBe(44);
    });
    it('E19: Worker and Chromium fixture hosts each have a recorded session group', async () => {
      const directory = process.env.NOOK_TEST_PROCESS_GROUPS;
      if (!directory) throw new Error('Isolated group registry required.');
      const groups = new Set(
        (await registeredMacProcessGroups(directory)).map(
          (record) => record.group,
        ),
      );
      const hosts = (await snapshotProcesses()).filter(
        (item) => groups.has(item.group ?? -1) && item.group === item.pid,
      );
      expect(hosts.some((item) => item.name === 'workerd')).toBe(true);
      expect(hosts.some((item) => /chrom|headless/i.test(item.name))).toBe(
        true,
      );
    });
    it('E19: a security child reparented after CLI SIGKILL is found through its recorded group', async () => {
      const before = await snapshotProcesses();
      await shim(
        '#!/bin/sh\nprintf "%s" "$$" > "$HOME/stalled-pid"\nexec /bin/sleep 300\n',
      );
      const child = keyring.start(['login', app.origin]);
      let owned: Awaited<ReturnType<typeof readHostProcess>>;
      try {
        await expect
          .poll(() => existsSync(resolve(keyring.home, 'stalled-pid')))
          .toBe(true);
        const pid = Number(
          await readFile(resolve(keyring.home, 'stalled-pid'), 'utf8'),
        );
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
        owned = await readHostProcess(pid);
        await registeredMacProcessGroups(
          resolve(keyring.home, 'fixture-process-groups'),
        );
        child.kill('SIGKILL');
        await child.done;
        await expect
          .poll(async () => (await readHostProcess(pid))?.parent)
          .toBe(1);
        const directory = process.env.NOOK_TEST_PROCESS_GROUPS;
        if (!directory) throw new Error('Isolated group registry required.');
        const records = await registeredMacProcessGroups(directory);
        expect(records.some((record) => record.group === pid)).toBe(true);
        const orphans = orphanedProcesses(before, await snapshotProcesses(), {
          id: 'synthetic-run',
          pid: Number(process.env.NOOK_TEST_ROOT_PID),
          home: keyring.home,
          groups: records,
        });
        expect(orphans.some((item) => item.pid === pid)).toBe(true);
        expect(
          await killOrphans(orphans.filter((item) => item.pid === pid)),
        ).toEqual([`orphaned test process PID ${pid} terminated`]);
        await expect.poll(() => readHostProcess(pid)).toBeUndefined();
      } finally {
        child.kill('SIGKILL');
        await child.done;
        if (owned) await killOrphans([owned]);
      }
    });
  },
);

async function readUserCodeWithLongProbe(child: { output: () => string }) {
  await expect
    .poll(
      () =>
        /\b[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}\b/.test(
          child.output(),
        ),
      { timeout: 22_000 },
    )
    .toBe(true);
  return /\b[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}\b/.exec(
    child.output(),
  )![0];
}
