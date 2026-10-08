import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { beforeEach, expect, it } from 'vitest';
import { evidenceRoot } from '../scripts/lib/instrument.ts';
import {
  createArgs,
  createdPath,
  createTransport,
} from './support/agent-create.ts';
import { auditRows } from './support/audit.ts';
import { filesContain, privateKeyring } from './support/cli.ts';
import { issueGrant, machineMcp } from './support/grants.ts';
import { listMachines, revokeMachine } from './support/machines.ts';
import { expectOutput } from './support/private-assertions.ts';
import { testBuild } from './support/runtime.ts';
import {
  createSecret,
  decryptRow,
  expectNoValue,
  replaceSecret,
  secretInput,
  secretRows,
  vaultRuntime,
} from './support/vault.ts';
import { vaultCheckpoints } from './support/vault-checkpoints.ts';

let app: Awaited<ReturnType<typeof vaultRuntime>>;
let keyring: Awaited<ReturnType<typeof privateKeyring>>;
let token: string;
beforeEach(async () => {
  app = await vaultRuntime();
  keyring = await privateKeyring();
  ({ token } = await issueGrant(app, ['work/acme']));
  await configure(app.origin);
  return async () => {
    await keyring.close();
    await app.close();
  };
});
async function configure(origin: string, credential = token) {
  await mkdir(dirname(keyring.config), { recursive: true });
  await writeFile(keyring.config, JSON.stringify({ url: origin }));
  expect(await keyring.store(origin, credential)).toBe(0);
}
async function transcript() {
  return readFile(resolve(keyring.home, 'argv'), 'utf8').catch(() => '');
}
function childEnv() {
  return process.env.COVERAGE_RUN
    ? { NOOK_CLI_COVERAGE: resolve(evidenceRoot, `cli-${randomUUID()}.json`) }
    : {};
}
const unconfirmed = `Could not confirm whether ${createdPath} was stored.`;
it('E1/E4/E20: real create, run, list and MCP preserve exact bytes without exposing values or writing plaintext', async () => {
  const value = secretInput().value;
  const result = await keyring.start(
    [...createArgs(), '--description', 'Provider API token'],
    {},
    value + '\n',
  ).done;
  expect(result.status).toBe(0);
  expectOutput(result.stdout, `Stored ${createdPath}.`, true);
  expect(result.stderr.length).toBe(0);
  const [row] = await secretRows(app);
  expect((await decryptRow(app.key, row)) === value).toBe(true);
  const [audit] = await auditRows(app);
  expectNoValue(JSON.stringify(audit), [value, token, app.key]);
  expect(audit).toMatchObject({
    outcome: 'created',
    path: createdPath,
    working_directory: await realpath(keyring.home),
    purpose: 'token from provider setup',
  });
  const listing = await keyring.start(['vault', 'list', 'work/acme']).done;
  expect(listing.status).toBe(0);
  expectOutput(listing.stdout, `${createdPath}  Provider API token`, true);
  const hash = createHash('sha256').update(value).digest('hex');
  const run = await keyring.start([
    'run',
    '--secret',
    `GH_TOKEN=${createdPath}`,
    '--purpose',
    'check the new token',
    '--',
    process.execPath,
    resolve('tests/support/run-child.ts'),
    'streams',
    hash,
  ]).done;
  expect(run.status).toBe(0);
  expectNoValue(run.stdout + run.stderr, [value, token, app.key]);
  expect(JSON.parse(run.stdout.split('\n')[0]).valueMatches).toBe(true);
  const mcp = await machineMcp(app, token).call('list_secrets', {
    bucket: 'work/acme',
  });
  expectNoValue(JSON.stringify(mcp), [value, token, app.key]);
  expect(
    (mcp.structuredContent!.secrets as { description: string }[])[0]
      .description,
  ).toBe('Provider API token');
  expectNoValue(
    result.stdout +
      result.stderr +
      listing.stdout +
      run.stdout +
      JSON.stringify(mcp) +
      (await transcript()),
    [value, token, app.key],
  );
  expect(await filesContain(keyring.home, value)).toBe(false);
});
it.each(
  [
    { input: 'a\n\n', expected: 'a\n' },
    { input: 'a\r\n', expected: 'a' },
    { input: 'a', expected: 'a' },
    { input: '\ufeffa\n', expected: '\ufeffa' },
    { input: '  a\t\r', expected: '  a\t\r' },
    { input: 'a'.repeat(65536) + '\r\n', expected: 'a'.repeat(65536) },
  ].map((sample, index) => ({ ...sample, index })),
)(
  'E2: remove exactly one final LF or CRLF and retain other bytes ($index)',
  async ({ input, expected }) => {
    const result = await keyring.start(createArgs(), {}, input).done;
    expect(result.status).toBe(0);
    expect(
      (await decryptRow(app.key, (await secretRows(app))[0])) === expected,
    ).toBe(true);
    expect((await secretRows(app))[0].description === '').toBe(true);
  },
);
it.skipIf(process.platform !== 'linux').each(['tty-open', 'tty-invalid'])(
  'E3/E8: an unfinished or invalid terminal input (%s) is rejected privately before HTTP',
  async (mode) => {
    const transport = await createTransport(app, () => undefined);
    try {
      await configure(transport.origin);
      const before = await transcript();
      const result = await keyring.command(
        process.execPath,
        [
          resolve('tests/support/create-input.ts'),
          mode,
          resolve(testBuild, 'cli.js'),
        ],
        childEnv(),
        mode === 'tty-open' ? 'a'.repeat(100_000) : '',
      ).done;
      expect(result.status).toBe(1);
      expectOutput(result.stdout, `Value for ${createdPath}: `);
      expectOutput(
        result.stdout + result.stderr,
        mode === 'tty-open'
          ? 'A value can be at most 64 KiB.'
          : 'Use valid Unicode for the value.',
      );
      expect(transport.bodies.length).toBe(0);
      expect((await transcript()) === before).toBe(true);
      expect(await secretRows(app)).toEqual([]);
      expect(await auditRows(app)).toEqual([]);
    } finally {
      await transport.close();
    }
  },
);
it.skipIf(process.platform !== 'linux').each(['tty', 'tty-open'])(
  'E3: a genuine PTY prompts without echoing the typed value (%s)',
  async (mode) => {
    const value = secretInput().value;
    const command = keyring.command(
      process.execPath,
      [
        resolve('tests/support/create-input.ts'),
        mode,
        resolve(testBuild, 'cli.js'),
      ],
      childEnv(),
      value + '\n',
    );
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      command.kill('SIGKILL');
    }, 6000);
    let result: Awaited<typeof command.done>;
    try {
      result = await command.done;
    } finally {
      clearTimeout(deadline);
    }
    expect(timedOut).toBe(false);
    expect(result.status).toBe(0);
    expectOutput(result.stdout, `Value for ${createdPath}: `);
    expectOutput(result.stdout, `Stored ${createdPath}.`);
    expectNoValue(result.stdout + result.stderr, [value, token]);
    expect(
      (await decryptRow(app.key, (await secretRows(app))[0])) === value,
    ).toBe(true);
  },
);
it('E4: the creation records the realpath of a symlinked cwd', async () => {
  const directory = resolve(keyring.home, 'project');
  const link = resolve(keyring.home, 'project-link');
  await mkdir(directory);
  await symlink(directory, link);
  const entry = resolve(testBuild, 'cli.js');
  const script = `process.chdir(${JSON.stringify(link)}); process.argv=${JSON.stringify([process.execPath, entry, ...createArgs()])}; await import(${JSON.stringify(entry)});`;
  const result = await keyring.command(
    process.execPath,
    ['--input-type=module', '-e', script],
    childEnv(),
    secretInput().value,
  ).done;
  expect(result.status).toBe(0);
  expect((await auditRows(app))[0].working_directory).toBe(
    await realpath(directory),
  );
});
it.skipIf(process.platform !== 'linux')(
  'TTY input: a Unicode character split across consumed chunks remains exact',
  async () => {
    const value = '界';
    const result = await keyring.command(
      process.execPath,
      [
        resolve('tests/support/create-input.ts'),
        'tty-split',
        resolve(testBuild, 'cli.js'),
      ],
      childEnv(),
      value + '\n',
    ).done;
    expectNoValue(result.stdout + result.stderr, [value, token, app.key]);
    expect(result.status).toBe(0);
    expectOutput(result.stdout, `Stored ${createdPath}.`);
    expect(
      (await decryptRow(app.key, (await secretRows(app))[0])) === value,
    ).toBe(true);
  },
);
it.skipIf(process.platform !== 'linux').each([
  { label: 'Ctrl-C', control: '\x03' },
  { label: 'EOF', control: '\x04' },
])(
  'TTY lifecycle: $label closes privately without keyring or HTTP access',
  async ({ control }) => {
    const transport = await createTransport(app, () => undefined);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await configure(transport.origin);
      const before = await transcript();
      const command = keyring.command(
        process.execPath,
        [
          resolve('tests/support/create-input.ts'),
          'tty',
          resolve(testBuild, 'cli.js'),
        ],
        childEnv(),
        control,
      );
      let timedOut = false;
      deadline = setTimeout(() => {
        timedOut = true;
        command.kill('SIGKILL');
      }, 6000);
      const result = await command.done;
      expect(timedOut).toBe(false);
      expect(result.status).toBe(1);
      expectOutput(result.stdout + result.stderr, 'Enter a value.');
      expectNoValue(result.stdout + result.stderr, [token, app.key]);
      expect((await transcript()) === before).toBe(true);
      expect(transport.bodies.length).toBe(0);
      expect((await secretRows(app)).length).toBe(0);
      expect((await auditRows(app)).length).toBe(0);
    } finally {
      clearTimeout(deadline);
      await transport.close();
    }
  },
);
it('E5: a duplicate name reports the conflict and leaves its value, description, version and time unchanged', async () => {
  expect(
    (await createSecret(app, secretInput({ name: 'NEW_TOKEN' }))).status,
  ).toBe(201);
  const before = await secretRows(app);
  const result = await keyring.start(createArgs(), {}, secretInput().value)
    .done;
  expect(result.status).toBe(1);
  expectOutput(
    result.stdout + result.stderr,
    `${createdPath} already exists.`,
    true,
  );
  expect(await secretRows(app)).toEqual(before);
  expect(await auditRows(app)).toEqual([]);
});
it.each(['work/X', 'me/X', 'personal/X', 'work/acme/missing/X'])(
  'E6/E7: create refuses %s without storing or auditing',
  async (path) => {
    const result = await keyring.start(
      createArgs(path),
      {},
      secretInput().value,
    ).done;
    expect(result.status).toBe(1);
    expectOutput(
      result.stdout + result.stderr,
      path.includes('/missing/')
        ? 'Bucket not found.'
        : `Access to ${path} is forbidden.`,
      true,
    );
    expect(await secretRows(app)).toEqual([]);
    expect(await auditRows(app)).toEqual([]);
  },
);
it.each(
  [
    { input: '', message: 'Enter a value.' },
    { input: '\n', message: 'Enter a value.' },
    {
      input: 'a'.repeat(65537) + '\n',
      message: 'A value can be at most 64 KiB.',
    },
    { input: 'a\0b', message: 'A value cannot contain NUL.' },
    {
      args: ['vault', 'create', createdPath],
      message: 'A purpose is required.',
    },
    {
      args: [...createArgs().slice(0, -1), '  '],
      message: 'Purpose must be one line of 1 to 200 characters.',
    },
    {
      args: [...createArgs().slice(0, -1), 'two\nlines'],
      message: 'Purpose must be one line of 1 to 200 characters.',
    },
    {
      args: [...createArgs().slice(0, -1), 'a'.repeat(201)],
      message: 'Purpose must be one line of 1 to 200 characters.',
    },
    {
      args: createArgs('work/acme/bad'),
      message: 'Use a secret path such as work/acme/GH_TOKEN.',
    },
    {
      args: createArgs('Bad/X'),
      message: 'Use a secret path such as work/acme/GH_TOKEN.',
    },
    {
      args: [...createArgs(), '--description', 'two\nlines'],
      message: 'Use one line for the description.',
    },
  ].map((sample, index) => ({ ...sample, index })),
)(
  'E8: invalid CLI input $index fails before keyring or HTTP',
  async ({ input, args, message }) => {
    const transport = await createTransport(app, () => undefined);
    try {
      await configure(transport.origin);
      const before = await transcript();
      const result = await keyring.start(
        args ?? createArgs(),
        {},
        input ?? secretInput().value,
      ).done;
      expect(result.status).toBe(1);
      expectOutput(result.stdout + result.stderr, message, true);
      expect(transport.bodies.length).toBe(0);
      expect((await transcript()) === before).toBe(true);
      expect(await secretRows(app)).toEqual([]);
      expect(await auditRows(app)).toEqual([]);
    } finally {
      await transport.close();
    }
  },
);
it.each(['invalid-utf8', 'open-pipe'])(
  'E8: %s is rejected without waiting for unbounded stdin or sending HTTP',
  async (mode) => {
    const transport = await createTransport(app, () => undefined);
    try {
      await configure(transport.origin);
      const result = await keyring.command(
        process.execPath,
        [
          resolve('tests/support/create-input.ts'),
          mode,
          resolve(testBuild, 'cli.js'),
        ],
        childEnv(),
      ).done;
      expect(result.status).toBe(1);
      expectOutput(
        result.stdout + result.stderr,
        mode === 'invalid-utf8'
          ? 'Use valid Unicode for the value.'
          : 'A value can be at most 64 KiB.',
        true,
      );
      expect(transport.bodies.length).toBe(0);
    } finally {
      await transport.close();
    }
  },
);
it.each(['flag', 'positional'])(
  'E10: no value is accepted by %s arguments or reflected in usage',
  async (mode) => {
    const value = secretInput().value;
    const before = await transcript();
    const result = await keyring.start(
      [...createArgs(), ...(mode === 'flag' ? ['--value', value] : [value])],
      {},
      value,
    ).done;
    expect(result.status).toBe(1);
    expectOutput(
      result.stdout + result.stderr,
      'Usage: nook vault create <bucket>/<NAME> --purpose "…" [--description "…"]',
      true,
    );
    expectNoValue(result.stdout + result.stderr, [value]);
    expect((await transcript()) === before).toBe(true);
    expect(await secretRows(app)).toEqual([]);
    expect(await auditRows(app)).toEqual([]);
  },
);
it.each([
  { args: ['vault', 'create'], label: 'missing path' },
  { args: [...createArgs(), '--description'], label: 'dangling description' },
  {
    args: [...createArgs(), '--purpose', 'other purpose'],
    label: 'duplicate purpose',
  },
  {
    args: [
      ...createArgs(),
      '--description',
      'first',
      '--description',
      'second',
    ],
    label: 'duplicate description',
  },
])('CLI usage: $label is refused before keyring or HTTP', async ({ args }) => {
  const transport = await createTransport(app, () => undefined);
  try {
    await configure(transport.origin);
    const before = await transcript();
    const result = await keyring.start(args, {}, secretInput().value).done;
    expect(result.status).toBe(1);
    expectOutput(
      result.stdout + result.stderr,
      'Usage: nook vault create <bucket>/<NAME> --purpose "…" [--description "…"]',
      true,
    );
    expect(transport.bodies.length).toBe(0);
    expect((await transcript()) === before).toBe(true);
    expect((await secretRows(app)).length).toBe(0);
    expect((await auditRows(app)).length).toBe(0);
  } finally {
    await transport.close();
  }
});
it('HTTP error body: an incomplete known configuration shape remains definitive', async () => {
  const transport = await createTransport(app, (attempt) =>
    attempt === 1
      ? { status: 503, body: { _tag: 'VaultNotConfigured' } }
      : undefined,
  );
  try {
    await configure(transport.origin);
    const value = secretInput().value;
    const result = await keyring.start(createArgs(), {}, value).done;
    expectNoValue(result.stdout + result.stderr, [value, token, app.key]);
    expect({
      status: result.status,
      requests: transport.bodies.length,
      stored: (await secretRows(app)).length,
      audits: (await auditRows(app)).length,
    }).toEqual({ status: 1, requests: 1, stored: 0, audits: 0 });
    expectOutput(
      result.stdout + result.stderr,
      `Could not reach ${transport.origin}. Try again.`,
      true,
    );
  } finally {
    await transport.close();
  }
});
it('CLI cwd: a disappeared working directory refuses create before keyring or HTTP', async () => {
  const directory = resolve(keyring.home, 'disappeared-cwd');
  await mkdir(directory);
  const transport = await createTransport(app, () => undefined);
  try {
    await configure(transport.origin);
    const before = await transcript();
    const entry = resolve(testBuild, 'cli.js');
    const script = `import { rmdirSync } from 'node:fs'; process.chdir(${JSON.stringify(directory)}); rmdirSync(${JSON.stringify(directory)}); process.argv=${JSON.stringify([process.execPath, entry, ...createArgs()])}; await import(${JSON.stringify(entry)});`;
    const result = await keyring.command(
      process.execPath,
      ['--input-type=module', '-e', script],
      childEnv(),
      secretInput().value,
    ).done;
    expect(result.status).toBe(1);
    expectOutput(
      result.stdout + result.stderr,
      'Could not resolve the working directory.',
      true,
    );
    expect(transport.bodies.length).toBe(0);
    expect((await transcript()) === before).toBe(true);
    expect((await secretRows(app)).length).toBe(0);
    expect((await auditRows(app)).length).toBe(0);
  } finally {
    await transport.close();
  }
});
it('E11: an unconfigured machine gives the create login placeholder', async () => {
  await rm(keyring.config);
  const result = await keyring.start(createArgs(), {}, secretInput().value)
    .done;
  expect(result.status).toBe(1);
  expectOutput(
    result.stdout + result.stderr,
    "This machine's token is no longer valid. Run: nook login <url>",
    true,
  );
  expect((await secretRows(app)).length).toBe(0);
  expect((await auditRows(app)).length).toBe(0);
});
it.each(['absent', 'revoked'])(
  'E11: %s token uses the create reconnect guidance',
  async (mode) => {
    if (mode === 'absent') {
      const args =
        process.platform === 'darwin'
          ? ['delete-generic-password', '-s', 'nook', '-a', app.origin]
          : ['clear', 'service', 'nook', 'url', app.origin];
      await keyring.command(
        process.platform === 'darwin'
          ? '/usr/bin/security'
          : '/usr/bin/secret-tool',
        args,
      ).done;
    } else
      expect(
        (await revokeMachine(app, (await listMachines(app))[0].id)).status,
      ).toBe(204);
    const result = await keyring.start(createArgs(), {}, secretInput().value)
      .done;
    expect(result.status).toBe(1);
    expectOutput(
      result.stdout + result.stderr,
      `This machine's token is no longer valid. Run: nook login ${app.origin}`,
      true,
    );
    expect(await secretRows(app)).toEqual([]);
    expect(await auditRows(app)).toEqual([]);
  },
);
it.each(['before', 'after'])(
  'E14/E15: retry a checkpoint failure %s the atomic batch with one row and audit',
  async (stage) => {
    let active = false;
    let failed = false;
    const measured = await vaultCheckpoints(async (label) => {
      if (active && !failed && label === `/${stage}-batch`) {
        failed = true;
        return false;
      }
      return true;
    });
    try {
      const credential = (await issueGrant(measured, ['work/acme'])).token;
      await configure(measured.origin, credential);
      active = true;
      const result = await keyring.start(createArgs(), {}, secretInput().value)
        .done;
      expect(failed).toBe(true);
      expect(result.status).toBe(0);
      expectOutput(
        result.stdout + result.stderr,
        `Stored ${createdPath}.`,
        true,
      );
      expect(await secretRows(measured)).toHaveLength(1);
      expect(await auditRows(measured)).toHaveLength(1);
    } finally {
      await measured.close();
    }
  },
);
it.each(['lost', 'hang', '503', 'unknown-500', 'unknown-5xx', 'committed'])(
  'E14/E15: %s retries reuse one UUID v4 and an identical payload',
  async (mode) => {
    const transport = await createTransport(
      app,
      (attempt) =>
        attempt > 1 || mode === 'committed'
          ? undefined
          : mode === 'lost' || mode === 'hang'
            ? mode
            : {
                status:
                  mode === '503' ? 503 : mode === 'unknown-500' ? 500 : 502,
                body: {
                  _tag:
                    mode === '503' ? 'ServiceUnavailable' : 'FutureTransient',
                },
              },
      async (attempt, response) => {
        expect(response.status).toBe(201);
        return mode === 'committed' && attempt === 1 ? 'lost' : undefined;
      },
    );
    try {
      await configure(transport.origin);
      const result = await keyring.start(createArgs(), {}, secretInput().value)
        .done;
      expect(result.status).toBe(0);
      expectOutput(
        result.stdout + result.stderr,
        `Stored ${createdPath}.`,
        true,
      );
      expect(transport.bodies.length).toBe(2);
      expect(transport.bodies[0].equals(transport.bodies[1])).toBe(true);
      let body: { writeId?: unknown };
      try {
        body = JSON.parse(transport.bodies[0].toString());
      } catch {
        throw new Error('Creation requests must contain valid JSON.');
      }
      expect(
        typeof body.writeId === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            body.writeId,
          ),
      ).toBe(true);
      expect(await secretRows(app)).toHaveLength(1);
      expect(await auditRows(app)).toHaveLength(1);
    } finally {
      await transport.close();
    }
  },
);
it('E16: a committed lost response followed by owner replacement remains unconfirmed', async () => {
  const transport = await createTransport(
    app,
    () => undefined,
    async (attempt, response) => {
      if (attempt !== 1) return;
      expect(response.status).toBe(201);
      const row = (await secretRows(app))[0];
      expect(
        (
          await replaceSecret(app, createdPath, {
            ...secretInput(),
            expectedVersion: row.version,
          })
        ).status,
      ).toBe(200);
      return 'lost';
    },
  );
  try {
    await configure(transport.origin);
    const result = await keyring.start(createArgs(), {}, secretInput().value)
      .done;
    expect(result.status).toBe(1);
    expectOutput(result.stdout + result.stderr, unconfirmed, true);
    expect(transport.bodies.length).toBe(2);
    expect(await auditRows(app)).toHaveLength(1);
  } finally {
    await transport.close();
  }
});
it('E14/E15: an opened error body stays within the request timeout before replaying the identical payload', async () => {
  const transport = await createTransport(app, (attempt) =>
    attempt === 1 ? 'open-error-body' : undefined,
  );
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await configure(transport.origin);
    const command = keyring.start(createArgs(), {}, secretInput().value);
    let timedOut = false;
    deadline = setTimeout(() => {
      timedOut = true;
      command.kill('SIGKILL');
    }, 20_000);
    const result = await command.done;
    expect({
      withinDeadline: !timedOut,
      status: result.status,
      requests: transport.bodies.length,
      stored: (await secretRows(app)).length,
      audits: (await auditRows(app)).length,
    }).toEqual({
      withinDeadline: true,
      status: 0,
      requests: 2,
      stored: 1,
      audits: 1,
    });
    expect(transport.bodies[0].equals(transport.bodies[1])).toBe(true);
    expectOutput(result.stdout + result.stderr, `Stored ${createdPath}.`, true);
  } finally {
    clearTimeout(deadline);
    await transport.close();
  }
});
it('E15: a committed response cut after 201 headers replays the identical payload and confirms once', async () => {
  const transport = await createTransport(
    app,
    () => undefined,
    async (attempt, response) => {
      expect(response.status).toBe(201);
      return attempt === 1 ? 'partial-201' : undefined;
    },
  );
  try {
    await configure(transport.origin);
    const result = await keyring.start(createArgs(), {}, secretInput().value)
      .done;
    expect({
      status: result.status,
      requests: transport.bodies.length,
      stored: (await secretRows(app)).length,
      audits: (await auditRows(app)).length,
    }).toEqual({ status: 0, requests: 2, stored: 1, audits: 1 });
    expect(transport.bodies[0].equals(transport.bodies[1])).toBe(true);
    expectOutput(result.stdout + result.stderr, `Stored ${createdPath}.`, true);
  } finally {
    await transport.close();
  }
});
it.each([
  { status: 409, tag: 'SecretExists' },
  { status: 403, tag: 'Forbidden' },
  { status: 404, tag: 'BucketNotFound' },
  { status: 400, tag: 'InvalidSecret' },
  { status: 401, tag: 'Unauthorized' },
  { status: 503, tag: 'VaultNotConfigured' },
])(
  'E16: after an unconfirmed attempt, $tag cannot claim a definitive refusal',
  async ({ status, tag }) => {
    const transport = await createTransport(app, (attempt) =>
      attempt === 1
        ? 'lost'
        : { status, body: { _tag: tag, message: 'definitive refusal' } },
    );
    try {
      await configure(transport.origin);
      const result = await keyring.start(createArgs(), {}, secretInput().value)
        .done;
      expect(result.status).toBe(1);
      expectOutput(result.stdout + result.stderr, unconfirmed, true);
      expect(transport.bodies.length).toBe(2);
    } finally {
      await transport.close();
    }
  },
);
it('E17: an initial VaultNotConfigured is definitive and is not retried', async () => {
  await app.setBindings({ ...app.bindings, VAULT_KEY: '' });
  const transport = await createTransport(app, () => undefined);
  try {
    await configure(transport.origin);
    const result = await keyring.start(createArgs(), {}, secretInput().value)
      .done;
    expect(result.status).toBe(1);
    expectOutput(
      result.stdout + result.stderr,
      'This installation has no VAULT_KEY. Add it as a Worker secret, then try again.',
      true,
    );
    expect(transport.bodies.length).toBe(1);
  } finally {
    await transport.close();
  }
});
it('E18: exactly three unconfirmed attempts stop with the unconfirmed message', async () => {
  const transport = await createTransport(app, () => ({
    status: 502,
    body: { _tag: 'FutureTransient' },
  }));
  try {
    await configure(transport.origin);
    const result = await keyring.start(createArgs(), {}, secretInput().value)
      .done;
    expect(result.status).toBe(1);
    expectOutput(result.stdout + result.stderr, unconfirmed, true);
    expect(transport.bodies.length).toBe(3);
    expect(
      transport.bodies.every((body) => body.equals(transport.bodies[0])),
    ).toBe(true);
  } finally {
    await transport.close();
  }
});
it('E19: an unknown definitive tag preserves its public message without retrying', async () => {
  const transport = await createTransport(app, () => ({
    status: 422,
    body: { _tag: 'FutureRefusal', message: 'A future public refusal.' },
  }));
  try {
    await configure(transport.origin);
    const result = await keyring.start(createArgs(), {}, secretInput().value)
      .done;
    expect(result.status).toBe(1);
    expectOutput(
      result.stdout + result.stderr,
      'A future public refusal.',
      true,
    );
    expect(transport.bodies.length).toBe(1);
  } finally {
    await transport.close();
  }
});
it.each([
  { status: 422, shape: 'invalid JSON', rawBody: '{"_tag":', retry: false },
  { status: 502, shape: 'invalid JSON', rawBody: '{"_tag":', retry: true },
  { status: 422, shape: 'invalid shape', rawBody: '{"_tag":7}', retry: false },
  { status: 502, shape: 'invalid shape', rawBody: '{"_tag":7}', retry: true },
])(
  'HTTP error body: complete $shape $status keeps transport retry policy',
  async ({ status, rawBody, retry }) => {
    const transport = await createTransport(app, (attempt) =>
      attempt === 1 ? { status, body: undefined, rawBody } : undefined,
    );
    try {
      await configure(transport.origin);
      const value = secretInput().value;
      const result = await keyring.start(createArgs(), {}, value).done;
      expectNoValue(result.stdout + result.stderr, [value, token, app.key]);
      expect({
        status: result.status,
        requests: transport.bodies.length,
        stored: (await secretRows(app)).length,
        audits: (await auditRows(app)).length,
      }).toEqual({
        status: retry ? 0 : 1,
        requests: retry ? 2 : 1,
        stored: retry ? 1 : 0,
        audits: retry ? 1 : 0,
      });
      if (retry)
        expect(transport.bodies[0].equals(transport.bodies[1])).toBe(true);
      expectOutput(
        result.stdout + result.stderr,
        retry
          ? `Stored ${createdPath}.`
          : `Could not reach ${transport.origin}. Try again.`,
        true,
      );
    } finally {
      await transport.close();
    }
  },
);
