import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { beforeEach, expect, it } from 'vitest';
import { approve, ownerRuntime } from './support/authorizations.ts';
import {
  type PrivateKeyring,
  privateKeyring,
  readUserCode,
} from './support/cli.ts';
import { machineProxy } from './support/machine-proxy.ts';
import {
  configHasOnlyUrl,
  expectOutput,
} from './support/private-assertions.ts';
import { runtime, type TestRuntime } from './support/runtime.ts';

let app: TestRuntime;
let keyring: PrivateKeyring;
beforeEach(async () => {
  app = await ownerRuntime(await runtime());
  keyring = await privateKeyring();
  return async () => {
    await keyring.close();
    await app.close();
  };
});
async function login() {
  const child = keyring.start(['login', app.origin]);
  expect((await approve(app, await readUserCode(child))).status).toBe(204);
  const result = await child.done;
  expect(result.status).toBe(0);
  return result;
}
async function requestCount() {
  return (
    await (
      await app.mf.getD1Database('DB')
    )
      .prepare('SELECT count(*) AS count FROM authorizations')
      .first()
  )?.count;
}
it.each(['keyring-store', 'config-save'] as const)(
  'a failed %s revokes the issued credential and clears any partial keyring write',
  async (failure) => {
    const previous = 'https://previous.nook.test';
    if (failure === 'keyring-store') {
      await mkdir(resolve(keyring.home, 'config/nook'), { recursive: true });
      await writeFile(keyring.config, JSON.stringify({ url: previous }));
    }
    const child = keyring.start(['login', app.origin]);
    const code = await readUserCode(child);
    if (failure === 'config-save')
      await mkdir(keyring.config, { recursive: true });
    else
      await writeFile(
        resolve(keyring.shim, 'secret-tool'),
        '#!/bin/sh\n/usr/bin/secret-tool "$@"\nstatus=$?\nif [ "$1" = "store" ]; then exit 2; fi\nexit "$status"\n',
        { mode: 0o700 },
      );
    expect((await approve(app, code)).status).toBe(204);
    const result = await child.done;
    expect(result.status).toBe(1);
    expectOutput(
      result.stdout + result.stderr,
      failure === 'config-save'
        ? 'Could not save the Nook installation URL.'
        : 'Nook keeps its token in the Secret Service keyring and could not use it.',
    );
    expect(
      (await keyring.lookup(app.origin)) === '',
      'No partial credential remains',
    ).toBe(true);
    expect(
      (
        await (
          await app.mf.getD1Database('DB')
        )
          .prepare('SELECT count(*) AS count FROM machine_tokens')
          .first()
      )?.count,
    ).toBe(0);
    if (failure === 'keyring-store')
      expect(await configHasOnlyUrl(keyring.config, previous)).toBe(true);
  },
);
it.each([1, 2])(
  'lookup status %s with a diagnostic fails without replacing an active session',
  async (status) => {
    await login();
    const token = await keyring.lookup(app.origin);
    await writeFile(
      resolve(keyring.shim, 'secret-tool'),
      `#!/bin/sh\nif [ "$1" = "lookup" ]; then /usr/bin/secret-tool "$@" >/dev/null; printf "Synthetic lookup failure\\n" >&2; exit ${status}; fi\nexec /usr/bin/secret-tool "$@"\n`,
      { mode: 0o700 },
    );
    for (const args of [['whoami'], ['logout'], ['login', app.origin]]) {
      const child = keyring.start(args);
      // Finish a mistakenly created login too, so failures cannot leave a live child.
      await expect.poll(async () => child.output().length > 0).toBe(true);
      if (child.output().includes('Waiting for approval'))
        await (await app.mf.getD1Database('DB'))
          .prepare('UPDATE authorizations SET expires_at=0')
          .run();
      const result = await child.done;
      expect(result.status).toBe(1);
      expectOutput(
        result.stdout + result.stderr,
        'Nook keeps its token in the Secret Service keyring and could not use it.',
      );
    }
    expect(await requestCount()).toBe(0);
    expect(
      (await keyring.lookup(app.origin)) === token,
      'Lookup failure preserves the active credential',
    ).toBe(true);
  },
);
it('a slow browser opener leaves the server poll interval unchanged', async () => {
  let started = 0;
  const polls: number[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (request.url === '/api/machine/token') polls.push(Date.now());
      const forwarded = await fetch(`${app.origin}${request.url}`, {
        method: request.method,
        headers: { 'Content-Type': 'application/json' },
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      if (request.url === '/api/machine/authorizations') started = Date.now();
      response.writeHead(forwarded.status, {
        'Content-Type':
          forwarded.headers.get('Content-Type') ?? 'application/json',
      });
      response.end(Buffer.from(await forwarded.arrayBuffer()));
    } catch {
      response.writeHead(503).end();
    }
  });
  try {
    await writeFile(
      resolve(keyring.shim, 'xdg-open'),
      '#!/bin/sh\nsleep 60\n',
      { mode: 0o700 },
    );
    await new Promise<void>((accept) => server.listen(0, '127.0.0.1', accept));
    const address = server.address();
    if (typeof address !== 'object' || !address)
      throw new Error('Local proxy unavailable');
    const child = keyring.start(['login', `http://127.0.0.1:${address.port}`]);
    const code = await readUserCode(child);
    await expect.poll(() => polls.length >= 1, { timeout: 10_000 }).toBe(true);
    expect((await approve(app, code)).status).toBe(204);
    expect((await child.done).status).toBe(0);
    expect(polls.length >= 2).toBe(true);
    expect(
      polls.every((time, i) => time - (i ? polls[i - 1] : started) >= 1800),
    ).toBe(true);
    expect(
      polls.every((time, i) => time - (i ? polls[i - 1] : started) < 3500),
      'Each two-second poll runs independently of the opener',
    ).toBe(true);
  } finally {
    await new Promise<void>((accept) => server.close(() => accept()));
  }
});
it.each([
  'http://example.nook.test',
  'https://synthetic-user@example.nook.test',
  'https://:synthetic-password@example.nook.test',
  'https://example.nook.test/path',
  'https://example.nook.test?code=synthetic',
  'https://example.nook.test#synthetic',
])(
  'login rejects the unsupported origin %s before creating a request',
  async (origin) => {
    const result = await keyring.start(['login', origin]).done;
    expect(result.status).toBe(1);
    expectOutput(
      result.stdout + result.stderr,
      'Use the HTTPS origin of your Nook installation, without a path, query, or credentials.',
    );
    expect(await requestCount()).toBe(0);
    expect(existsSync(keyring.config)).toBe(false);
  },
);
it.each(['{not-json', '{"url":[]}', '{"url":null}'])(
  'malformed configuration fails without creating a request (%s)',
  async (content) => {
    await mkdir(resolve(keyring.home, 'config/nook'), { recursive: true });
    await writeFile(keyring.config, content);
    const result = await keyring.start(['login', app.origin]).done;
    expect(result.status).toBe(1);
    expectOutput(
      result.stdout + result.stderr,
      'Could not read the Nook configuration.',
    );
    expect(await requestCount()).toBe(0);
  },
);
it('a configuration URL cannot be an array that coerces to a valid origin', async () => {
  await mkdir(resolve(keyring.home, 'config/nook'), { recursive: true });
  await writeFile(keyring.config, JSON.stringify({ url: [app.origin] }));
  const result = await keyring.start(['login', app.origin]).done;
  expect(result.status).toBe(1);
  expectOutput(
    result.stdout + result.stderr,
    'Could not read the Nook configuration.',
  );
  expect(await requestCount()).toBe(0);
});
it.each([undefined, '', 'relative-config'])(
  'XDG_CONFIG_HOME %j remembers only the origin under HOME/.config',
  async (xdg) => {
    const child = keyring.start(['login', app.origin], {
      XDG_CONFIG_HOME: xdg,
    });
    expect((await approve(app, await readUserCode(child))).status).toBe(204);
    expect((await child.done).status).toBe(0);
    expect(
      await configHasOnlyUrl(
        resolve(keyring.home, '.config/nook/config.json'),
        app.origin,
      ),
    ).toBe(true);
    expect(existsSync(keyring.config)).toBe(false);
    const identity = await keyring.start(['whoami'], {
      XDG_CONFIG_HOME: xdg,
    }).done;
    expect(identity.status).toBe(0);
  },
);
it('a removed pending request exits with the generic invalid-request message without storing anything', async () => {
  const child = keyring.start(['login', app.origin]);
  await readUserCode(child);
  await (await app.mf.getD1Database('DB'))
    .prepare('DELETE FROM authorizations')
    .run();
  const result = await child.done;
  expect(result.status).toBe(1);
  expectOutput(
    result.stdout + result.stderr,
    `The login request is no longer valid. Run: nook login ${app.origin}`,
  );
  expect((await keyring.lookup(app.origin)) === '').toBe(true);
  expect(existsSync(keyring.config)).toBe(false);
});
it('a child cannot override the private session bus', async () => {
  expect(() =>
    keyring.start(['login', app.origin], {
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/nook-nonexistent-test-bus',
    }),
  ).toThrow('Private bus overrides are forbidden.');
  expect(await requestCount()).toBe(0);
});
it('failed persistence and revocation retain a recoverable keyring session without creating another request', async () => {
  let unavailable = true;
  const proxy = await machineProxy(app, ({ method }) =>
    method === 'DELETE' && unavailable ? 503 : undefined,
  );
  try {
    const child = keyring.start(['login', proxy.origin]);
    const code = await readUserCode(child);
    await mkdir(keyring.config, { recursive: true });
    expect((await approve(app, code)).status).toBe(204);
    const result = await child.done;
    expect(result.status).toBe(1);
    expectOutput(
      result.stdout + result.stderr,
      `The issued token could not be revoked. Fix the configuration path and keyring, then run: nook login ${proxy.origin}`,
    );
    const token = await keyring.lookup(proxy.origin);
    expect(
      Boolean(token),
      'The recoverable credential stays in the keyring',
    ).toBe(true);
    expect(await requestCount()).toBe(0);
    await rm(keyring.config, { recursive: true });
    unavailable = false;
    const retry = await keyring.start(['login', proxy.origin]).done;
    expect(retry.status).toBe(1);
    expectOutput(retry.stdout + retry.stderr, 'Already logged in to');
    expect(await requestCount()).toBe(0);
    expect(await configHasOnlyUrl(keyring.config, proxy.origin)).toBe(true);
    expect((await keyring.lookup(proxy.origin)) === token).toBe(true);
    expect((await keyring.start(['whoami']).done).status).toBe(0);
    expect((await keyring.start(['logout']).done).status).toBe(0);
    expect((await keyring.lookup(proxy.origin)) === '').toBe(true);
  } finally {
    await proxy.close();
  }
});
it('secret-tool stderr cannot expose its stdin credential through the CLI', async () => {
  await writeFile(
    resolve(keyring.shim, 'secret-tool'),
    [
      '#!/bin/sh',
      'if [ "$1" = "store" ]; then',
      '  case "$2" in',
      '    "--label=Nook machine "*)',
      '      nook_test_input="$(/usr/bin/cat)"',
      '      printf "%s" "$nook_test_input" >&2',
      '      printf "%s" "$nook_test_input" | /usr/bin/secret-tool "$@"',
      '      exit $?',
      '    ;;',
      '  esac',
      'fi',
      'exec /usr/bin/secret-tool "$@"',
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  const result = await login();
  const token = await keyring.lookup(app.origin);
  expect(Boolean(token)).toBe(true);
  expect(
    (result.stdout + result.stderr).includes(token),
    'Subprocess diagnostics stay private',
  ).toBe(false);
});
it('a stalled keyring probe times out before creating a request', async () => {
  await writeFile(
    resolve(keyring.shim, 'secret-tool'),
    '#!/bin/sh\nsleep 60\n',
    { mode: 0o700 },
  );
  const started = Date.now();
  const result = await keyring.start(['login', app.origin]).done;
  expect(result.status).toBe(1);
  expectOutput(
    result.stdout + result.stderr,
    'Nook keeps its token in the Secret Service keyring and could not use it.',
  );
  expect(Date.now() - started >= 9000 && Date.now() - started < 15_000).toBe(
    true,
  );
  expect(await requestCount()).toBe(0);
});
it.each(['whoami', 'logout'] as const)(
  'a stalled %s request times out while retaining the credential',
  async (command) => {
    let stalled = false;
    const proxy = await machineProxy(app, () => (stalled ? 'hang' : undefined));
    try {
      const child = keyring.start(['login', proxy.origin]);
      expect((await approve(app, await readUserCode(child))).status).toBe(204);
      expect((await child.done).status).toBe(0);
      const token = await keyring.lookup(proxy.origin);
      stalled = true;
      const started = Date.now();
      const result = await keyring.start([command]).done;
      expect(result.status).toBe(1);
      expectOutput(
        result.stdout + result.stderr,
        command === 'logout'
          ? `Could not reach ${proxy.origin}; the token is still active. Try again.`
          : `Could not reach ${proxy.origin}. Try again.`,
        true,
      );
      expect(
        Date.now() - started >= 9000 && Date.now() - started < 15_000,
      ).toBe(true);
      expect((await keyring.lookup(proxy.origin)) === token).toBe(true);
    } finally {
      await proxy.close();
    }
  },
);
it('a failed keyring clear after revocation remains recoverable by logout', async () => {
  await login();
  await writeFile(
    resolve(keyring.shim, 'secret-tool'),
    '#!/bin/sh\nif [ "$1" = "clear" ] && [ "$3" = "nook" ]; then exit 2; fi\nexec /usr/bin/secret-tool "$@"\n',
    { mode: 0o700 },
  );
  const failed = await keyring.start(['logout']).done;
  expect(failed.status).toBe(1);
  expectOutput(
    failed.stdout + failed.stderr,
    'Nook keeps its token in the Secret Service keyring and could not use it.',
  );
  expect(Boolean(await keyring.lookup(app.origin))).toBe(true);
  await writeFile(
    resolve(keyring.shim, 'secret-tool'),
    '#!/bin/sh\nexec /usr/bin/secret-tool "$@"\n',
    { mode: 0o700 },
  );
  expect((await keyring.start(['logout']).done).status).toBe(0);
  expect((await keyring.lookup(app.origin)) === '').toBe(true);
});
