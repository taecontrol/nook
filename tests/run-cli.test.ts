import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { beforeEach, expect, it } from 'vitest';
import {
  acmePath,
  auditPageData,
  auditRows,
  runFixture,
} from './support/audit.ts';
import { filesContain, privateKeyring } from './support/cli.ts';
import { issueGrant } from './support/grants.ts';
import { revokeMachine } from './support/machines.ts';
import { expectOutput } from './support/private-assertions.ts';
import { testBuild } from './support/runtime.ts';
import { createSecret, expectNoValue, secretInput } from './support/vault.ts';
import { vaultCheckpoints } from './support/vault-checkpoints.ts';

let app: Awaited<ReturnType<typeof runFixture>>;
let keyring: Awaited<ReturnType<typeof privateKeyring>>;
const childFile = resolve('tests/support/run-child.ts');
const runArgs = (
  command: string[] = [process.execPath, childFile, 'streams'],
  secrets = [`GH_TOKEN=${acmePath}`],
) => [
  'run',
  ...secrets.flatMap((secret) => ['--secret', secret]),
  '--purpose',
  'open the release PR',
  '--',
  ...command,
];
beforeEach(async () => {
  app = await runFixture();
  keyring = await privateKeyring();
  await mkdir(dirname(keyring.config), { recursive: true });
  await writeFile(keyring.config, JSON.stringify({ url: app.origin }));
  expect(await keyring.store(app.origin, app.token)).toBe(0);
  return async () => {
    await keyring.close();
    await app.close();
  };
});
it.each([0, 1, 42])(
  'E1/E5/E28: exact injected bytes, inherited env, stdin and unchanged child streams/code (%s)',
  async (exit) => {
    const hash = createHash('sha256').update(app.input.value).digest('hex');
    const result = await keyring.start(
      runArgs(
        [process.execPath, childFile, 'streams', hash, String(exit)],
        [`GH_TOKEN=${acmePath}`, `ALIAS=${acmePath}`],
      ),
      { NOOK_TEST_INHERITED: 'caller-marker', GH_TOKEN: 'inherited-marker' },
      'piped input\n',
    ).done;
    expect(result.status).toBe(exit);
    expectOutput(
      result.stdout,
      JSON.stringify({
        valueMatches: true,
        aliasMatches: true,
        inherited: 'caller-marker',
        tokenAbsent: true,
        argvPrivate: true,
        stdin: 'piped input\n',
      }) + '\nstdout-one\nstdout-two',
      true,
    );
    expectOutput(result.stderr, 'stderr-one\nstderr-two', true);
    const entries = (await auditPageData(app)).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      workingDirectory: await realpath(process.cwd()),
      executable: process.execPath.split('/').at(-1),
      purpose: 'open the release PR',
    });
    expectNoValue(
      result.stdout +
        result.stderr +
        (await readFile(resolve(keyring.home, 'argv'), 'utf8')),
      [app.input.value, app.token, app.key],
    );
    expect(await filesContain(keyring.home, app.input.value)).toBe(false);
  },
);
it.skipIf(process.platform !== 'linux')(
  'E2: inherited PTY preserves all three child TTYs',
  async () => {
    const args = [
      process.execPath,
      resolve(testBuild, 'cli.js'),
      ...runArgs([process.execPath, childFile, 'tty']),
    ];
    const command = args
      .map((arg) => "'" + arg.replaceAll("'", "'\\''") + "'")
      .join(' ');
    const result = await keyring.command('/usr/bin/script', [
      '--quiet',
      '--return',
      '--command',
      command,
      '/dev/null',
    ]).done;
    expect(result.status).toBe(0);
    expectOutput(result.stdout, '[true,true,true]', true);
    expect(result.stderr).toBe('');
  },
);
it('E3: a signalled child maps SIGTERM to 143', async () => {
  expect(
    (
      await keyring.start(runArgs([process.execPath, childFile, 'self-signal']))
        .done
    ).status,
  ).toBe(143);
});
it.each(['SIGTERM', 'SIGHUP', 'SIGINT'] as const)(
  'E3: %s reaches the child or leaves its decision intact',
  async (signal) => {
    const running = keyring.start(
      runArgs([process.execPath, childFile, 'wait']),
    );
    await expect
      .poll(() => running.output().includes('child-ready'))
      .toBe(true);
    running.kill(signal);
    if (signal === 'SIGINT') {
      // The parent ignores SIGINT; sending TERM later proves it stayed alive and forwarded it.
      running.kill('SIGTERM');
    }
    const result = await running.done;
    expect(result.status).toBe(0);
    expectOutput(
      result.stdout,
      'child-ready\n' + (signal === 'SIGINT' ? 'SIGTERM' : signal),
      true,
    );
  },
);
it('E4: command resolution precedes keyring/network, with 127 and 126', async () => {
  const locked = resolve(keyring.home, 'not-executable');
  await writeFile(locked, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
  const before = await readFile(resolve(keyring.home, 'argv'), 'utf8');
  for (const [name, code, message] of [
    [
      'nook-command-that-does-not-exist',
      127,
      'Command not found: nook-command-that-does-not-exist',
    ],
    [locked, 126, `Command is not executable: ${locked}`],
  ] as const) {
    const result = await keyring.start(runArgs([name])).done;
    expect(result.status).toBe(code);
    expectOutput(result.stdout + result.stderr, message, true);
  }
  expect(
    (await readFile(resolve(keyring.home, 'argv'), 'utf8')) === before,
  ).toBe(true);
  expect(await auditRows(app)).toEqual([]);
});
it.each(
  [
    ['--secret', `GH_TOKEN=${acmePath}`, '--', 'node'],
    ['--secret', `GH_TOKEN=${acmePath}`, '--purpose', '', '--', 'node'],
    ['--secret', `GH_TOKEN=${acmePath}`, '--purpose', '   ', '--', 'node'],
    [
      '--secret',
      `GH_TOKEN=${acmePath}`,
      '--purpose',
      'bad\nline',
      '--',
      'node',
    ],
    [
      '--secret',
      `GH_TOKEN=${acmePath}`,
      '--purpose',
      '🔐'.repeat(201),
      '--',
      'node',
    ],
    ['--purpose', 'test', '--', 'node'],
    ...[
      'GH_TOKEN',
      '=work/acme/GH_TOKEN',
      '1X=work/acme/GH_TOKEN',
      'GH_TOKEN=work/acme',
      'GH_TOKEN=Work/Acme/GH_TOKEN',
    ].map((secret) => ['--secret', secret, '--purpose', 'test', '--', 'node']),
    [
      '--secret',
      `GH_TOKEN=${acmePath}`,
      '--secret',
      `GH_TOKEN=${acmePath}`,
      '--purpose',
      'test',
      '--',
      'node',
    ],
    ['--secret', `GH_TOKEN=${acmePath}`, '--purpose', 'test', 'node'],
    ['--secret', `GH_TOKEN=${acmePath}`, '--purpose', 'test', '--'],
  ].map((args) => ({ args })),
)(
  'E6: invalid run args stop before the keyring with one useful line (%#)',
  async ({ args }) => {
    const before = await readFile(resolve(keyring.home, 'argv'), 'utf8');
    const result = await keyring.start(['run', ...args]).done;
    expect(result.status).toBe(1);
    expect((result.stdout + result.stderr).trim().split('\n')).toHaveLength(1);
    expect((result.stdout + result.stderr).trim().length).toBeGreaterThan(0);
    expect(
      (await readFile(resolve(keyring.home, 'argv'), 'utf8')) === before,
    ).toBe(true);
    expect(await auditRows(app)).toEqual([]);
  },
);
it('E6: incomplete run prints its required usage', async () => {
  const result = await keyring.start(['run']).done;
  expect(result.status).toBe(1);
  expectOutput(
    result.stdout + result.stderr,
    'Usage: nook run --secret ENV=bucket/NAME --purpose "…" -- <command>',
    true,
  );
});
it.each(
  [
    ['personal/finances/PLAID_SECRET'],
    [acmePath, 'personal/finances/PLAID_SECRET'],
    ['personal/missing/ABSENT'],
    ['work/acme/MISSING'],
  ].map((paths) => ({ paths })),
)(
  'E7/E8: all-or-nothing failures never start the child (%#)',
  async ({ paths }) => {
    const result = await keyring.start(
      runArgs(
        [process.execPath, childFile, 'tty'],
        paths.map((path, i) => `KEY_${i}=${path}`),
      ),
    ).done;
    const denied = paths.find((path) => path.startsWith('personal/'));
    expect(result.status).toBe(1);
    expectOutput(
      result.stdout + result.stderr,
      denied
        ? `Access to ${denied} is forbidden.`
        : 'work/acme/MISSING was not found.',
      true,
    );
    expect((await auditRows(app)).length).toBe(denied ? 1 : 0);
    expectNoValue(result.stdout + result.stderr, [
      app.input.value,
      app.token,
      app.key,
    ]);
  },
);
it('E8/E9: missing keys, absent login, revoked tokens and offline Worker keep reconnect output private', async () => {
  await app.setBindings({ ...app.bindings, VAULT_KEY: '' });
  let result = await keyring.start(runArgs()).done;
  expect(result.status).toBe(1);
  expectOutput(
    result.stdout + result.stderr,
    'This installation has no VAULT_KEY. Add it as a Worker secret, then try again.',
    true,
  );
  await app.setBindings(app.bindings);
  await revokeMachine(app, app.machine.id);
  result = await keyring.start(runArgs()).done;
  expect(result.status).toBe(1);
  expectOutput(
    result.stdout + result.stderr,
    `This machine's token is no longer valid. Run: nook login ${app.origin}`,
    true,
  );
  await writeFile(
    keyring.config,
    JSON.stringify({ url: 'http://127.0.0.1:10239' }),
  );
  await keyring.store('http://127.0.0.1:10239', app.token);
  result = await keyring.start(runArgs()).done;
  expect(result.status).toBe(1);
  expectOutput(
    result.stdout + result.stderr,
    'Could not reach http://127.0.0.1:10239. Try again.',
    true,
  );
  await rm(keyring.config);
  result = await keyring.start(runArgs()).done;
  expect(result.status).toBe(1);
  expectOutput(
    result.stdout + result.stderr,
    'Not logged in. Run: nook login <your Nook URL>',
    true,
  );
  expectNoValue(result.stdout + result.stderr, [
    app.input.value,
    app.token,
    app.key,
  ]);
});

it.each(['removed', 'permission-lost'])(
  'E4: a command %s after resolution keeps its recorded audit and spawn exit code',
  async (kind) => {
    const command = resolve(keyring.home, 'race-command');
    let active = false;
    let batches = 0;
    const measured = await vaultCheckpoints(async (label) => {
      if (active && label === '/after-batch' && ++batches === 2) {
        if (kind === 'removed') await rm(command);
        else await chmod(command, 0o600);
      }
      return true;
    });
    try {
      await writeFile(command, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      expect(
        (await createSecret(measured, secretInput({ name: 'GH_TOKEN' })))
          .status,
      ).toBe(201);
      const { token } = await issueGrant(measured, ['work/acme']);
      await keyring.store(measured.origin, token);
      await writeFile(keyring.config, JSON.stringify({ url: measured.origin }));
      active = true;
      const result = await keyring.start(runArgs([command])).done;
      expect(result.status).toBe(kind === 'removed' ? 127 : 126);
      expectOutput(
        result.stdout + result.stderr,
        kind === 'removed'
          ? `Command not found: ${command}`
          : `Command is not executable: ${command}`,
        true,
      );
      expect(await auditRows(measured)).toHaveLength(1);
    } finally {
      await measured.close();
    }
  },
);
it('E1: a quiet successful child produces no CLI output', async () => {
  const result = await keyring.start(runArgs(['/usr/bin/true'])).done;
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
});
