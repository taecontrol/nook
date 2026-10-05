import { existsSync } from 'node:fs';
import { readFile, rename, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import {
  approve,
  createAuthorization,
  ownerRuntime,
} from './support/authorizations.ts';
import { closeBrowserPage } from './support/buckets-browser.ts';
import {
  filesContain,
  type PrivateKeyring,
  privateKeyring,
  readUserCode,
} from './support/cli.ts';
import {
  configHasOnlyUrl,
  expectOutput,
  waitingOutput,
} from './support/private-assertions.ts';
import { runtime, type TestRuntime } from './support/runtime.ts';

let browser: Browser;
let closeBrowser: (() => Promise<void>) | undefined;
let app: TestRuntime;
let keyring: PrivateKeyring;
let appClosed = false;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
});
beforeEach(async () => {
  appClosed = false;
  app = await ownerRuntime(await runtime());
  keyring = await privateKeyring();
  return async () => {
    await keyring.close();
    if (!appClosed) await app.close();
  };
});
async function login() {
  const child = keyring.start(['login', app.origin]);
  const code = await readUserCode(child);
  expect((await approve(app, code, hostname())).status).toBe(204);
  const result = await child.done;
  expect(result.status).toBe(0);
  return result;
}
it('E1/E12: Linux login approves in Chromium, stores only in the private keyring, and whoami identifies the machine', async () => {
  const child = keyring.start(['login', app.origin]);
  const code = await readUserCode(child);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${app.origin}/cli/authorize`);
    await page
      .getByRole('textbox', { name: 'Code from your terminal' })
      .fill(code);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const name = page.getByRole('textbox', {
      name: 'Machine name',
      exact: true,
    });
    await name.waitFor();
    expect(await name.inputValue()).toBe(hostname());
    await name.press('Enter');
    await page
      .getByRole('heading', { name: 'Machine approved', exact: true })
      .waitFor();
    const loggedIn = await child.done;
    expect(loggedIn.status).toBe(0);
    expectOutput(
      loggedIn.stdout,
      `${waitingOutput(app.origin, code)}\nLogged in to ${app.origin} as ${hostname()}. Token stored in the system keyring.`,
      true,
    );
    const token = await keyring.lookup(app.origin);
    expect(
      /^nook_[A-Za-z0-9_-]{43}$/.test(token),
      'A machine token is stored in the real keyring',
    ).toBe(true);
    const identity = await keyring.start(['whoami']).done;
    expect(identity.status).toBe(0);
    expectOutput(
      identity.stdout,
      `${hostname()} at ${app.origin}\nAccess: all buckets`,
      true,
    );
    expect(await configHasOnlyUrl(keyring.config, app.origin)).toBe(true);
    expect(
      await filesContain(keyring.home, token),
      'No plaintext credential exists before logout',
    ).toBe(false);
    const loggedOut = await keyring.start(['logout']).done;
    expect(loggedOut.status).toBe(0);
    for (const result of [loggedIn, identity, loggedOut])
      expect(
        (result.stdout + result.stderr).includes(token),
        'No command output contains the token',
      ).toBe(false);
    expect(
      await filesContain(keyring.home, token),
      'HOME, config, state, cache, and recorded argv contain no token',
    ).toBe(false);
  } finally {
    await closeBrowserPage(page, context);
  }
});
it.each(['success', 'failure', 'missing'] as const)(
  'E2: browser opener %s uses a code-free URL and never interrupts the login',
  async (mode) => {
    if (mode === 'missing')
      await rename(
        resolve(keyring.shim, 'xdg-open'),
        resolve(keyring.shim, 'disabled-opener'),
      );
    const child = keyring.start(['login', app.origin], {
      PATH: keyring.shim,
      NOOK_TEST_OPEN_STATUS: mode === 'failure' ? '1' : '0',
    });
    // secret-tool delegates by absolute path, so the opener may be absent safely.
    const code = await readUserCode(child);
    const expected = waitingOutput(app.origin, code);
    expectOutput(child.output(), expected, true);
    if (mode !== 'missing') {
      await expect
        .poll(async () => existsSync(resolve(keyring.home, 'opened')))
        .toBe(true);
      expect(
        (await readFile(resolve(keyring.home, 'opened'), 'utf8')).trim() ===
          `${app.origin}/cli/authorize`,
        'The browser receives only the bare approval URL',
      ).toBe(true);
    }
    expect((await approve(app, code)).status).toBe(204);
    expect((await child.done).status).toBe(0);
  },
);
it('E3: denial in Chromium exits without a keyring entry or configuration', async () => {
  const child = keyring.start(['login', app.origin]);
  const code = await readUserCode(child);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${app.origin}/cli/authorize`);
    await page
      .getByRole('textbox', { name: 'Code from your terminal' })
      .fill(code);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Deny', exact: true }).click();
    await page.getByRole('heading', { name: 'Request denied' }).waitFor();
    const result = await child.done;
    expect(result.status).toBe(1);
    expectOutput(
      result.stdout + result.stderr,
      `${waitingOutput(app.origin, code)}\nLogin denied. Nothing was stored.`,
      true,
    );
    expect(
      (await keyring.lookup(app.origin)) === '',
      'The keyring has no machine credential',
    ).toBe(true);
    expect(existsSync(keyring.config)).toBe(false);
  } finally {
    await closeBrowserPage(page, context);
  }
});
it('E4: an expired D1 request exits without storing anything', async () => {
  const child = keyring.start(['login', app.origin]);
  const code = await readUserCode(child);
  await (await app.mf.getD1Database('DB'))
    .prepare('UPDATE authorizations SET expires_at=0')
    .run();
  const result = await child.done;
  expect(result.status).toBe(1);
  expectOutput(
    result.stdout + result.stderr,
    `${waitingOutput(app.origin, code)}\nThe login request expired. Run: nook login ${app.origin}`,
    true,
  );
  expect(
    (await keyring.lookup(app.origin)) === '',
    'The keyring has no machine credential',
  ).toBe(true);
  expect(existsSync(keyring.config)).toBe(false);
});
it('E5: existing login refuses without creating a request or replacing the keyring token', async () => {
  await login();
  const token = await keyring.lookup(app.origin);
  const db = await app.mf.getD1Database('DB');
  const before = (await db.prepare('SELECT * FROM authorizations').all())
    .results;
  const result = await keyring.start(['login', app.origin]).done;
  expect(result.status).toBe(1);
  expectOutput(
    result.stdout + result.stderr,
    `Already logged in to ${app.origin} as ${hostname()}. Run: nook logout`,
    true,
  );
  expect(
    JSON.stringify(
      (await db.prepare('SELECT * FROM authorizations').all()).results,
    ) === JSON.stringify(before),
    'No authorization request was created',
  ).toBe(true);
  expect(
    (await keyring.lookup(app.origin)) === token,
    'Existing credential is unchanged',
  ).toBe(true);
});
it('E6: logout revokes the old token, clears the keyring, and retains only the installation URL', async () => {
  await login();
  const token = await keyring.lookup(app.origin);
  const result = await keyring.start(['logout']).done;
  expect(result.status).toBe(0);
  expectOutput(
    result.stdout,
    `Logged out of ${app.origin}. The token was revoked and removed from the keyring.`,
    true,
  );
  expect(
    (await keyring.lookup(app.origin)) === '',
    'The keyring has no machine credential',
  ).toBe(true);
  expect(await configHasOnlyUrl(keyring.config, app.origin)).toBe(true);
  expect(
    (
      await fetch(`${app.origin}/api/machine/whoami`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status,
  ).toBe(401);
  const identity = await keyring.start(['whoami']).done;
  expect(identity.status).toBe(1);
  expectOutput(
    identity.stdout + identity.stderr,
    `Not logged in. Run: nook login ${app.origin}`,
    true,
  );
});
it('E7: externally revoked tokens report invalid identity and logout clears the stale credential', async () => {
  await login();
  await (await app.mf.getD1Database('DB'))
    .prepare('DELETE FROM machine_tokens')
    .run();
  const identity = await keyring.start(['whoami']).done;
  expect(identity.status).toBe(1);
  expectOutput(
    identity.stdout + identity.stderr,
    `This machine's token is no longer valid. Run: nook login ${app.origin}`,
    true,
  );
  const logout = await keyring.start(['logout']).done;
  expect(logout.status).toBe(0);
  expect(
    (await keyring.lookup(app.origin)) === '',
    'The keyring has no machine credential',
  ).toBe(true);
});
it.each(['unreachable', 'server-error'] as const)(
  'E8: logout against %s retains the active keyring credential',
  async (mode) => {
    await login();
    const token = await keyring.lookup(app.origin);
    if (mode === 'unreachable') {
      await app.close();
      appClosed = true;
    } else
      await (await app.mf.getD1Database('DB'))
        .prepare(
          'ALTER TABLE machine_tokens RENAME TO unavailable_machine_tokens',
        )
        .run();
    const result = await keyring.start(['logout']).done;
    expect(result.status).toBe(1);
    expectOutput(
      result.stdout + result.stderr,
      `Could not reach ${app.origin}; the token is still active. Try again.`,
      true,
    );
    expect(
      (await keyring.lookup(app.origin)) === token,
      'Failed revocation must retain the token',
    ).toBe(true);
  },
);
it.each(['missing-binary', 'missing-service'] as const)(
  'E9: %s fails before creating an authorization or configuration',
  async (mode) => {
    if (mode === 'missing-binary')
      await rm(resolve(keyring.shim, 'secret-tool'));
    else {
      await keyring.close();
      keyring = await privateKeyring('absent');
    }
    const result = await keyring.start(['login', app.origin], {
      PATH: keyring.shim,
    }).done;
    expect(result.status).toBe(1);
    expectOutput(
      result.stdout + result.stderr,
      'Nook keeps its token in the Secret Service keyring and could not use it. Install secret-tool (libsecret), unlock your keyring, and try again.',
      true,
    );
    expect(existsSync(keyring.config)).toBe(false);
    // The table may not exist in the red phase; endpoint existence is a separate acceptance obligation.
    const tables = (
      await (
        await app.mf.getD1Database('DB')
      )
        .prepare("SELECT name FROM sqlite_master WHERE name='authorizations'")
        .all()
    ).results;
    if (tables.length)
      expect(
        (
          await (
            await app.mf.getD1Database('DB')
          )
            .prepare('SELECT count(*) AS count FROM authorizations')
            .first()
        )?.count,
      ).toBe(0);
  },
);
it('E11: the CLI reports the pending request cap without storing a token', async () => {
  for (let i = 0; i < 20; i++) await createAuthorization(app);
  const result = await keyring.start(['login', app.origin]).done;
  expect(result.status).toBe(1);
  expectOutput(
    result.stdout + result.stderr,
    'Too many pending login requests. Wait a few minutes and try again.',
    true,
  );
  expect(
    (await keyring.lookup(app.origin)) === '',
    'The keyring has no machine credential',
  ).toBe(true);
});
it('an unconfigured CLI gives the exact login guidance', async () => {
  for (const command of ['whoami', 'logout']) {
    const result = await keyring.start([command]).done;
    expect(result.status).toBe(1);
    expectOutput(
      result.stdout + result.stderr,
      'Not logged in. Run: nook login <your Nook URL>',
      true,
    );
  }
});
