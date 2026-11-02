import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, stop } from 'esbuild';
import { beforeEach, expect, it } from 'vitest';
import { evidenceRoot } from '../scripts/lib/instrument.ts';
import { buildExecutable } from '../scripts/release/binary.ts';
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
import {
  createSecret,
  expectNoValue,
  keyFingerprint,
  secretInput,
} from './support/vault.ts';
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
const marker = `<nook:${acmePath}>`;
const maskingArgs = (mode: string, extra: string[] = [], secrets?: string[]) =>
  runArgs([process.execPath, childFile, mode, ...extra], secrets);
function coverageEnvironment() {
  return process.env.COVERAGE_RUN
    ? {
        NOOK_CLI_COVERAGE: resolve(
          evidenceRoot,
          `cli-${crypto.randomUUID()}.json`,
        ),
      }
    : {};
}
function relaySeam() {
  return {
    NODE_OPTIONS: [
      ...(process.platform === 'darwin'
        ? [resolve(keyring.home, 'process-groups.mjs')]
        : []),
      resolve('tests/support/run-relay-seam.ts'),
    ]
      .map((file) => `--import=${pathToFileURL(file).href}`)
      .join(' '),
  };
}
async function outputProbe(mode: string, args: string[]) {
  const result = await keyring.command(
    process.execPath,
    [
      resolve('tests/support/run-output.ts'),
      mode,
      resolve(testBuild, 'cli.js'),
      ...args,
    ],
    { ...coverageEnvironment(), ...relaySeam() },
  ).done;
  expect(result.status).toBe(0);
  expect(result.stderr === '').toBe(true);
  const report = JSON.parse(result.stdout) as {
    status: number;
    stdout: string;
    stderr: string;
    stdoutClosed: boolean;
    stderrClosed: boolean;
  };
  return {
    status: report.status,
    stdout: Buffer.from(report.stdout ?? '', 'base64'),
    stderr: Buffer.from(report.stderr ?? '', 'base64'),
    stdoutClosed: report.stdoutClosed,
    stderrClosed: report.stderrClosed,
  };
}
async function addValue(name: string, value: string) {
  expect((await createSecret(app, secretInput({ name, value }))).status).toBe(
    201,
  );
  return `work/acme/${name}`;
}
async function nativeSignal(
  running: { kill(signal: NodeJS.Signals): boolean | Promise<boolean> },
  signal: NodeJS.Signals,
) {
  expect(
    await running.kill(signal),
    `Native signal ${signal} must be delivered`,
  ).toBe(true);
}
async function keyringTranscript() {
  try {
    return await readFile(resolve(keyring.home, 'argv'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}
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
      workingDirectory: await realpath(keyring.home),
      executable: process.execPath.split('/').at(-1),
      purpose: 'open the release PR',
    });
    expectNoValue(result.stdout + result.stderr + (await keyringTranscript()), [
      app.input.value,
      app.token,
      app.key,
    ]);
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
    const result = await keyring.command(
      '/usr/bin/script',
      ['--quiet', '--return', '--command', command, '/dev/null'],
      process.env.COVERAGE_RUN
        ? {
            NOOK_CLI_COVERAGE: resolve(
              evidenceRoot,
              `cli-${crypto.randomUUID()}.json`,
            ),
          }
        : {},
    ).done;
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
it.each(['SIGTERM', 'SIGHUP', 'SIGINT'] as const)(
  'E3: the private fixture distinguishes %s termination from exit code 1',
  async (signal) => {
    const exited = await keyring.command(process.execPath, [
      '-e',
      'process.exit(1)',
    ]).done;
    const terminated = await keyring.command(process.execPath, [
      '-e',
      'process.kill(process.pid, process.argv[1])',
      signal,
    ]).done;
    expectNoValue(
      exited.stdout + exited.stderr + terminated.stdout + terminated.stderr,
      [app.input.value, app.token, app.key],
    );
    expect(exited.status).toBe(1);
    expect(terminated.status).toBe(1);
    expect(exited.signal === undefined).toBe(true);
    expect(terminated.signal === signal).toBe(true);
    expectOutput(exited.stdout + exited.stderr, '', true);
    expectOutput(terminated.stdout + terminated.stderr, '', true);
  },
);
it.each(['exited', 'closed'] as const)(
  'E3: the private fixture refuses native delivery after the command is %s',
  async (state) => {
    const command = keyring.command(process.execPath, [
      '-e',
      'process.exit(0)',
    ]);
    const result = await command.done;
    expectNoValue(result.stdout + result.stderr, [
      app.input.value,
      app.token,
      app.key,
    ]);
    expect(result.status).toBe(0);
    if (state === 'closed') await keyring.close();
    expect(await command.kill('SIGTERM')).toBe(false);
  },
);
it.each(['SIGTERM', 'SIGHUP', 'SIGINT'] as const)(
  'E3: native %s survives the real child launch window',
  async (signal) => {
    const release = resolve(keyring.home, 'spawn-release');
    const held = resolve(keyring.home, 'spawn-held');
    const returned = resolve(keyring.home, 'spawn-returned');
    const imports = [
      ...(process.platform === 'darwin'
        ? [resolve(keyring.home, 'process-groups.mjs')]
        : []),
      resolve('tests/support/run-spawn-gate.ts'),
    ]
      .map((file) => `--import=${pathToFileURL(file).href}`)
      .join(' ');
    const running = keyring.start(
      runArgs([process.execPath, childFile, 'startup-wait']),
      { NODE_OPTIONS: imports },
    );
    try {
      await expect
        .poll(
          () => existsSync(held) && running.output().includes('child-ready'),
        )
        .toBe(true);
      const parent = Number(await readFile(held, 'utf8'));
      expect(Number.isSafeInteger(parent) && parent > 0).toBe(true);
      expect(existsSync(returned)).toBe(false);
      await nativeSignal(running, signal);
      expect(existsSync(returned)).toBe(false);
      await writeFile(release, '');
      if (signal === 'SIGINT') {
        await expect.poll(() => existsSync(returned)).toBe(true);
        running.kill('SIGTERM');
      }
      const result = await running.done;
      expectNoValue(result.stdout + result.stderr, [
        app.input.value,
        app.token,
        app.key,
      ]);
      expect(result.status).toBe(0);
      expectOutput(
        result.stdout,
        'child-ready\n' + (signal === 'SIGINT' ? 'SIGTERM' : signal),
        true,
      );
    } finally {
      await writeFile(release, '');
    }
  },
);
it.each(
  (['SIGTERM', 'SIGHUP', 'SIGINT'] as const).flatMap((signal) => [
    { signal, kind: 'completes', code: 0 },
    { signal, kind: 'fails', code: 127 },
    { signal, kind: 'exceeds launch limits', code: 126 },
  ]),
)(
  'E3: native $signal remains native after the real run $kind',
  async ({ signal, kind, code }) => {
    const ready = resolve(keyring.home, 'run-completed');
    const imports = [
      ...(process.platform === 'darwin'
        ? [resolve(keyring.home, 'process-groups.mjs')]
        : []),
      resolve('tests/support/run-completion-gate.ts'),
    ]
      .map((file) => `--import=${pathToFileURL(file).href}`)
      .join(' ');
    const command =
      kind === 'fails'
        ? resolve(keyring.home, 'missing-interpreter')
        : '/usr/bin/true';
    if (kind === 'fails')
      await writeFile(command, '#!/nook-fixture-missing-interpreter\n', {
        mode: 0o700,
      });
    const nativeFile = resolve(keyring.home, 'large-environment.mjs');
    if (kind === 'exceeds launch limits') {
      // The registered outer Node process owns the native E2BIG-only attempt.
      try {
        await build({
          entryPoints: [resolve('tests/support/run-large-environment.ts')],
          outfile: nativeFile,
          bundle: true,
          format: 'esm',
          platform: 'node',
          target: 'node26',
          external: ['node:*'],
          banner: {
            js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
          },
        });
      } finally {
        stop();
      }
    }
    const running =
      kind === 'exceeds launch limits'
        ? keyring.command(process.execPath, [nativeFile], {
            NODE_OPTIONS: `--import=${pathToFileURL(resolve('tests/support/run-completion-gate.ts')).href}`,
          })
        : keyring.start(runArgs([command]), { NODE_OPTIONS: imports });
    await expect
      .poll(
        () => existsSync(ready) && running.output().includes('run-completed:'),
      )
      .toBe(true);
    const parent = Number(await readFile(ready, 'utf8'));
    expect(Number.isSafeInteger(parent) && parent > 0).toBe(true);
    await nativeSignal(running, signal);
    const result = await running.done;
    expectNoValue(result.stdout + result.stderr, [
      app.input.value,
      app.token,
      app.key,
    ]);
    // Both private platform fixtures map native termination to status 1.
    expect(result.status).toBe(1);
    expect(result.signal === signal).toBe(true);
    const failure =
      code === 127
        ? `Command not found: ${command}\n`
        : code === 126
          ? `Command is not executable: ${command}\n`
          : '';
    expectOutput(result.stdout, failure + `run-completed:${code}`, true);
    expectOutput(result.stderr, '', true);
    if (kind !== 'exceeds launch limits')
      expect(await auditRows(app)).toHaveLength(1);
  },
);
it('E4: command resolution precedes keyring/network, with 127 and 126', async () => {
  const locked = resolve(keyring.home, 'not-executable');
  await writeFile(locked, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
  const before = await readFile(resolve(keyring.home, 'argv'), 'utf8').catch(
    () => '',
  );
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
  expect((await keyringTranscript()) === before).toBe(true);
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
    const before = await readFile(resolve(keyring.home, 'argv'), 'utf8').catch(
      () => '',
    );
    const result = await keyring.start(['run', ...args]).done;
    expect(result.status).toBe(1);
    expect((result.stdout + result.stderr).trim().split('\n')).toHaveLength(1);
    expect((result.stdout + result.stderr).trim().length).toBeGreaterThan(0);
    expect(
      (await readFile(resolve(keyring.home, 'argv'), 'utf8').catch(
        () => '',
      )) === before,
    ).toBe(true);
    expect(await auditRows(app)).toEqual([]);
  },
);
it('E6: incomplete run prints its required usage', async () => {
  const result = await keyring.start(['run']).done;
  expect(result.status).toBe(1);
  expectOutput(
    result.stdout + result.stderr,
    'Usage: nook run --secret ENV=bucket/NAME --purpose "…" [--no-masking] -- <command>',
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
    `This machine's token is no longer valid. Run: nook logout && nook login ${app.origin}`,
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

it('E8: a mismatched key stops the child with only the recorded key fingerprint', async () => {
  await app.setBindings({
    ...app.bindings,
    VAULT_KEY: randomBytes(32).toString('base64'),
  });
  const result = await keyring.start(runArgs()).done;
  expect(result.status).toBe(1);
  expectOutput(
    result.stdout + result.stderr,
    `Cannot open a secret encrypted with key ${keyFingerprint(app.key)}.`,
    true,
  );
  expectNoValue(result.stdout + result.stderr, [
    app.input.value,
    app.key,
    app.token,
  ]);
  expect(await auditRows(app)).toEqual([]);
});

it('E1/E5: every accepted environment name reaches the child, including __proto__', async () => {
  const probe = resolve(keyring.home, 'environment-name.js');
  await writeFile(
    probe,
    "import { createHash } from 'node:crypto'; const value = process.env['__proto__']; process.stdout.write(String(createHash('sha256').update(typeof value === 'string' ? value : '').digest('hex') === process.argv[2]));",
  );
  const digest = createHash('sha256').update(app.input.value).digest('hex');
  const result = await keyring.start(
    runArgs([process.execPath, probe, digest], [`__proto__=${acmePath}`]),
  ).done;
  expect(result.status).toBe(0);
  expectOutput(result.stdout, 'true', true);
  expect(result.stderr).toBe('');
  expect(await auditRows(app)).toHaveLength(1);
  expectNoValue(result.stdout + result.stderr, [app.input.value, app.token]);
});

it.each([
  {
    args: ['--secret', `GH_TOKEN=${acmePath}`, '--', 'node'],
    message: 'A purpose is required.',
  },
  {
    args: ['--secret', '--', 'node'],
    message:
      'Usage: nook run --secret ENV=bucket/NAME --purpose "…" [--no-masking] -- <command>',
  },
  {
    args: ['--purpose', '--', 'node'],
    message:
      'Usage: nook run --secret ENV=bucket/NAME --purpose "…" [--no-masking] -- <command>',
  },
  {
    args: [
      '--secret',
      `GH_TOKEN=${acmePath}`,
      '--purpose',
      'test',
      '--purpose',
      'other',
      '--',
      'node',
    ],
    message:
      'Usage: nook run --secret ENV=bucket/NAME --purpose "…" [--no-masking] -- <command>',
  },
  {
    args: ['--secret', `GH_TOKEN=${acmePath}`, '--purpose', 'test', '--'],
    message:
      'Usage: nook run --secret ENV=bucket/NAME --purpose "…" [--no-masking] -- <command>',
  },
  {
    args: [
      '--secret',
      `GH_TOKEN=${acmePath}`,
      '--secret',
      `GH_TOKEN=${acmePath}`,
      '--purpose',
      'test',
      '--',
      'node',
    ],
    message: 'Environment name GH_TOKEN is repeated.',
  },
])(
  'E6: argument failures name their cause before keyring access (%#)',
  async ({ args, message }) => {
    const before = await keyringTranscript();
    const result = await keyring.start(['run', ...args]).done;
    expect(result.status).toBe(1);
    expectOutput(result.stdout + result.stderr, message, true);
    expect((await keyringTranscript()) === before).toBe(true);
    expect(await auditRows(app)).toEqual([]);
  },
);
it('E14: too many CLI paths fail before the keyring and network', async () => {
  const before = await keyringTranscript();
  const result = await keyring.start(
    runArgs(
      ['/usr/bin/true'],
      Array.from(
        { length: 21 },
        (_, index) => `KEY_${index}=work/acme/KEY_${index}`,
      ),
    ),
  ).done;
  expect(result.status).toBe(1);
  expectOutput(
    result.stdout + result.stderr,
    'Request 1 to 20 distinct secret paths.',
    true,
  );
  expect((await keyringTranscript()) === before).toBe(true);
  expect(await auditRows(app)).toEqual([]);
});

async function valueTransport(
  mode: 'normal' | 'incomplete' | 'lost' = 'normal',
) {
  const counts: number[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      counts.push(
        (JSON.parse(body.toString()) as { secrets: string[] }).secrets.length,
      );
      const delivered = await fetch(
        app.origin + '/api/machine/secrets/values',
        {
          method: 'POST',
          headers: {
            Authorization: request.headers.authorization ?? '',
            'Content-Type': 'application/json',
          },
          body,
        },
      );
      response.writeHead(delivered.status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      if (mode === 'lost') {
        await delivered.body?.cancel();
        response.destroy();
      } else if (mode === 'incomplete') {
        await delivered.body?.cancel();
        response.end(JSON.stringify({ values: [] }));
      } else response.end(Buffer.from(await delivered.arrayBuffer()));
    } catch {
      response.writeHead(503);
      response.end(JSON.stringify({ _tag: 'ServiceUnavailable' }));
    }
  });
  await new Promise<void>((accept) => server.listen(0, '127.0.0.1', accept));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await writeFile(keyring.config, JSON.stringify({ url: origin }));
  await keyring.store(origin, app.token);
  return {
    origin,
    counts,
    close: () =>
      new Promise<void>((accept) => {
        server.closeAllConnections();
        server.close(() => accept());
      }),
  };
}
it('E5: alias mappings send one path in the real value request', async () => {
  const transport = await valueTransport();
  try {
    const result = await keyring.start(
      runArgs(['/usr/bin/true'], [`GH_TOKEN=${acmePath}`, `ALIAS=${acmePath}`]),
    ).done;
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(transport.counts).toEqual([1]);
    expect(await auditRows(app)).toHaveLength(1);
  } finally {
    await transport.close();
  }
});
it('E9: an incomplete successful value response fails privately before spawning', async () => {
  const transport = await valueTransport('incomplete');
  try {
    const result = await keyring.start(
      runArgs([process.execPath, childFile, 'tty']),
    ).done;
    expect(result.status).toBe(1);
    expectOutput(
      result.stdout + result.stderr,
      `Could not reach ${transport.origin}. Try again.`,
      true,
    );
    expect(transport.counts).toEqual([1]);
    expect(await auditRows(app)).toHaveLength(1);
    expectNoValue(result.stdout + result.stderr, [
      app.input.value,
      app.token,
      app.key,
    ]);
  } finally {
    await transport.close();
  }
});
it('E11: the CLI does not retry a lost value response after the Worker audited delivery', async () => {
  const transport = await valueTransport('lost');
  try {
    const result = await keyring.start(
      runArgs([process.execPath, childFile, 'tty']),
    ).done;
    expect(result.status).toBe(1);
    expectOutput(
      result.stdout + result.stderr,
      `Could not reach ${transport.origin}. Try again.`,
      true,
    );
    expect(transport.counts).toEqual([1]);
    expect(await auditRows(app)).toHaveLength(1);
    expectNoValue(result.stdout + result.stderr, [
      app.input.value,
      app.token,
      app.key,
    ]);
  } finally {
    await transport.close();
  }
});

it('E4: a directory is denied before reading the keyring', async () => {
  const directory = resolve(keyring.home, 'directory-command');
  await mkdir(directory);
  const before = await keyringTranscript();
  const result = await keyring.start(runArgs([directory])).done;
  expect(result.status).toBe(126);
  expectOutput(
    result.stdout + result.stderr,
    `Command is not executable: ${directory}`,
    true,
  );
  expect((await keyringTranscript()) === before).toBe(true);
  expect(await auditRows(app)).toEqual([]);
});
it('E4: command lookup uses the caller PATH', async () => {
  await writeFile(
    resolve(keyring.shim, 'path-command'),
    '#!/bin/sh\nexit 42\n',
    { mode: 0o700 },
  );
  const result = await keyring.start(runArgs(['path-command'])).done;
  expect(result.status).toBe(42);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
  expect(await auditRows(app)).toHaveLength(1);
});
function runFrom(directory: string, args: string[], deleted = false) {
  const entry = resolve(testBuild, 'cli.js');
  const script = `import { rmdirSync } from 'node:fs'; process.chdir(${JSON.stringify(directory)}); ${deleted ? `rmdirSync(${JSON.stringify(directory)});` : ''} process.argv = ${JSON.stringify([process.execPath, entry, ...args])}; await import(${JSON.stringify(entry)});`;
  return keyring.command(
    process.execPath,
    ['--input-type=module', '-e', script],
    process.env.COVERAGE_RUN
      ? {
          NOOK_CLI_COVERAGE: resolve(
            evidenceRoot,
            `cli-${crypto.randomUUID()}.json`,
          ),
        }
      : {},
  ).done;
}
it('E4: a relative command path resolves from the real current directory', async () => {
  await writeFile(
    resolve(keyring.home, 'relative-command'),
    '#!/bin/sh\nexit 42\n',
    { mode: 0o700 },
  );
  const result = await runFrom(keyring.home, runArgs(['./relative-command']));
  expect(result.status).toBe(42);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
  expect((await auditPageData(app)).entries[0]).toMatchObject({
    workingDirectory: await realpath(keyring.home),
    executable: 'relative-command',
  });
});
it('E6: a disappeared working directory fails before keyring access', async () => {
  const directory = resolve(keyring.home, 'disappeared-cwd');
  await mkdir(directory);
  const before = await keyringTranscript();
  const result = await runFrom(directory, runArgs(['/usr/bin/true']), true);
  expect(result.status).toBe(1);
  expectOutput(
    result.stdout + result.stderr,
    'Could not resolve the working directory.',
    true,
  );
  expect((await keyringTranscript()) === before).toBe(true);
  expect(await auditRows(app)).toEqual([]);
});
it('CLI help lists the installed audited run command', async () => {
  const result = await keyring.start(['--help']).done;
  expect(result.status).toBe(0);
  expect(/\brun\b/.test(result.stdout)).toBe(true);
  expectOutput(result.stdout, 'Run a command with audited secrets.');
});
it('E1: the resolved command keeps argv0 and forwards arguments literally', async () => {
  await symlink(process.execPath, resolve(keyring.shim, 'node'));
  await symlink('/usr/bin/mkfifo', resolve(keyring.shim, 'mkfifo'));
  const probe = resolve(keyring.home, 'arguments.js');
  await writeFile(
    probe,
    "process.stdout.write(String(process.argv0 === 'node' && JSON.stringify(process.argv.slice(2)) === JSON.stringify(['a b', '$NOOK_TEST_INHERITED', '--flag'])));",
  );
  const result = await keyring.start(
    runArgs(['node', probe, 'a b', '$NOOK_TEST_INHERITED', '--flag']),
    { PATH: keyring.shim },
  ).done;
  expect(result.status).toBe(0);
  expectOutput(result.stdout, 'true', true);
  expect(result.stderr).toBe('');
  expect(await auditRows(app)).toHaveLength(1);
});

it('Masking E1: piped output closes and the relay exits after preserving masked output and exit 42', async () => {
  const result = await outputProbe(
    'binary',
    maskingArgs('print-value', ['42']),
  );
  expect(result.status).toBe(42);
  expect(result.stdout.equals(Buffer.from(`token=${marker}\n`))).toBe(true);
  expect(result.stderr.length).toBe(0);
  expect(result.stdoutClosed).toBe(true);
  expect(result.stderrClosed).toBe(true);
  const relay = JSON.parse(
    await readFile(resolve(keyring.home, 'relay-launch'), 'utf8'),
  ) as { pid: number };
  await expect
    .poll(
      async () =>
        (await keyring.command('/bin/kill', ['-0', String(relay.pid)]).done)
          .status,
    )
    .not.toBe(0);
});
it('Masking E2: a shared regular file retains all 2000 alternating writes in order', async () => {
  const result = await outputProbe('shared', maskingArgs('alternate'));
  expect(result.status).toBe(0);
  const expected = Array.from(
    { length: 2000 },
    (_, i) => `${i}:${i % 10 === 0 ? marker : 'plain'}\n`,
  ).join('');
  expect(result.stdout.equals(Buffer.from(expected))).toBe(true);
});
it('Masking E2: both child streams share one real FIFO for a shared destination', async () => {
  const result = await outputProbe('shared', maskingArgs('shared-fifo'));
  expect(result.status).toBe(0);
  expect(result.stdout.equals(Buffer.from('true'))).toBe(true);
});
it('Masking E3: separate pipes retain their stream and plain bytes', async () => {
  const result = await keyring.start(maskingArgs('separate')).done;
  expect(result.status).toBe(0);
  expectOutput(result.stdout, 'plain', true);
  expectOutput(result.stderr, marker, true);
});
it('Masking E4: writes 200 ms apart never expose a value fragment', async () => {
  const result = await keyring.start(maskingArgs('split-value')).done;
  expect(result.status).toBe(0);
  expectOutput(result.stdout, marker, true);
});
it('Masking E5: the longest containing value wins whole', async () => {
  const shorter = await addValue('SHORT', 'abcdefgh');
  const longer = await addValue('LONG', 'prefix-abcdefgh-suffix');
  const result = await keyring.start(
    maskingArgs('print-value', [], [`GH_TOKEN=${longer}`, `SHORT=${shorter}`]),
  ).done;
  expect(result.status).toBe(0);
  expectOutput(result.stdout, `token=<nook:${longer}>`, true);
});
it('Masking E6: duplicate values sort by path and aliases share that marker', async () => {
  const first = await addValue('AAA', app.input.value);
  const result = await keyring.start(
    maskingArgs(
      'all-values',
      ['GH_TOKEN,ALIAS,FIRST'],
      [`GH_TOKEN=${acmePath}`, `ALIAS=${acmePath}`, `FIRST=${first}`],
    ),
  ).done;
  expect(result.status).toBe(0);
  expectOutput(result.stdout, `<nook:${first}>|`.repeat(3), true);
});
it('Masking E7: seven Unicode code points pass through and eight are masked', async () => {
  const seven = '🔐'.repeat(7);
  const short = await addValue('SEVEN', seven);
  const eight = await addValue('EIGHT', seven + '🔑');
  const result = await keyring.start(
    maskingArgs(
      'all-values',
      ['SEVEN,EIGHT'],
      [`SEVEN=${short}`, `EIGHT=${eight}`],
    ),
  ).done;
  expect(result.status).toBe(0);
  expectOutput(result.stdout, `${seven}|<nook:${eight}>|`, true);
});
it('Masking E8: whole multiline bytes are masked and separate labelled lines survive', async () => {
  const result = await keyring.start(maskingArgs('multiline')).done;
  expect(result.status).toBe(0);
  expectOutput(
    result.stdout,
    marker +
      '|' +
      app.input.value
        .split('\n')
        .map((line) => `[${line}]\n`)
        .join('')
        .trimEnd(),
    true,
  );
});
it.skipIf(process.platform !== 'linux')(
  'Masking E9: three TTYs print values unchanged without starting a relay',
  async () => {
    await writeFile(resolve(keyring.home, 'refuse-relay'), '');
    const args = [
      process.execPath,
      resolve(testBuild, 'cli.js'),
      ...maskingArgs('tty-value'),
    ];
    const command = args
      .map((arg) => "'" + arg.replaceAll("'", "'\\''") + "'")
      .join(' ');
    const result = await keyring.command(
      '/usr/bin/script',
      ['--quiet', '--return', '--command', command, '/dev/null'],
      { ...coverageEnvironment(), ...relaySeam() },
    ).done;
    expect(result.status).toBe(0);
    expectOutput(result.stdout, '[true,true,true]');
    expect(
      result.stdout.includes(app.input.value.replaceAll('\n', '\r\n')),
    ).toBe(true);
    expect(existsSync(resolve(keyring.home, 'relay-launch'))).toBe(false);
  },
);
it.skipIf(process.platform !== 'linux')(
  'Masking E10: a TTY stays plain while redirected stderr is masked',
  async () => {
    const file = resolve(keyring.home, 'stderr-file');
    const args = [
      process.execPath,
      resolve(testBuild, 'cli.js'),
      ...maskingArgs('tty-value'),
    ];
    const command =
      args.map((arg) => "'" + arg.replaceAll("'", "'\\''") + "'").join(' ') +
      ` 2>'${file}'`;
    const result = await keyring.command(
      '/usr/bin/script',
      ['--quiet', '--return', '--command', command, '/dev/null'],
      coverageEnvironment(),
    ).done;
    expect(result.status).toBe(0);
    expectOutput(result.stdout, '[true,true,false]');
    expect(
      result.stdout.includes(app.input.value.replaceAll('\n', '\r\n')),
    ).toBe(true);
    expect((await readFile(file, 'utf8')) === marker).toBe(true);
  },
);
it('Masking E11: no-masking passes bytes unchanged without a relay', async () => {
  await writeFile(resolve(keyring.home, 'refuse-relay'), '');
  const args = maskingArgs('print-value');
  args.splice(1, 0, '--no-masking');
  const result = await keyring.start(args, relaySeam()).done;
  expect(result.status).toBe(0);
  expect(result.stdout === 'token=' + app.input.value + '\n').toBe(true);
  expect(existsSync(resolve(keyring.home, 'relay-launch'))).toBe(false);
});
it.each(
  [
    ['--no-masking', '--no-masking'],
    ['--no-masking', 'true'],
    ['--no-masking=false'],
  ].map((flags) => ({ flags })),
)(
  'Masking E11: invalid boolean occurrence starts nothing (%#)',
  async ({ flags }) => {
    const before = await keyringTranscript();
    const args = maskingArgs('mark', [resolve(keyring.home, 'started')]);
    args.splice(1, 0, ...flags);
    const result = await keyring.start(args).done;
    expect(result.status).toBe(1);
    expectOutput(
      result.stdout + result.stderr,
      'Usage: nook run --secret ENV=bucket/NAME --purpose "…" [--no-masking] -- <command>',
      true,
    );
    expect((await keyringTranscript()) === before).toBe(true);
    expect(await auditRows(app)).toEqual([]);
    expect(existsSync(resolve(keyring.home, 'started'))).toBe(false);
  },
);
it('Masking E12: an unterminated prompt arrives before the writer is released', async () => {
  const release = resolve(keyring.home, 'release');
  expect(
    (await keyring.command('/usr/bin/mkfifo', [release]).done).status,
  ).toBe(0);
  const result = await outputProbe('prompt', maskingArgs('prompt', [release]));
  expect(result.status).toBe(0);
  expect(result.stdout.equals(Buffer.from('Password: ' + marker))).toBe(true);
});
it('Masking E13: all 256 byte values survive a binary pipe exactly', async () => {
  const result = await outputProbe('binary', maskingArgs('bytes'));
  expect(result.status).toBe(0);
  expect(
    result.stdout.equals(Buffer.from(Array.from({ length: 256 }, (_, i) => i))),
  ).toBe(true);
});
it('Masking E14: head closes its pipe, yes gets SIGPIPE and run exits 141', async () => {
  const result = await outputProbe('head', runArgs(['/usr/bin/yes']));
  expect(result.status).toBe(141);
  expect(result.stdout.equals(Buffer.from('y\n'))).toBe(true);
  expect(result.stderr.length).toBe(0);
});
it.each(['SIGTERM', 'SIGHUP', 'SIGINT'] as const)(
  'Masking E15: %s keeps forwarding and the child status',
  async (signal) => {
    const running = keyring.start(maskingArgs('signal-status'));
    await expect
      .poll(() => running.output().includes('child-ready'))
      .toBe(true);
    await nativeSignal(running, signal);
    if (signal === 'SIGINT') await nativeSignal(running, 'SIGTERM');
    const result = await running.done;
    expect(result.status).toBe(143);
    expectOutput(
      result.stdout,
      'child-ready\n' + (signal === 'SIGINT' ? 'SIGTERM' : signal),
      true,
    );
  },
);
it.each(['background', 'background-separate'])(
  'Masking E16: run flushes and exits while a FIFO-gated background writer stays masked (%s)',
  async (destination) => {
    const before = `before:${marker}:tail${app.input.value.slice(0, 8)}`;
    const after = `after:${marker}`;
    const release = resolve(keyring.home, 'release');
    expect(
      (await keyring.command('/usr/bin/mkfifo', [release]).done).status,
    ).toBe(0);
    const result = await outputProbe(
      destination,
      maskingArgs('background', [keyring.home]),
    );
    expect(result.status).toBe(3);
    expect(
      (await readFile(resolve(keyring.home, 'exit-snapshot'), 'utf8')) ===
        before,
    ).toBe(true);
    await expect
      .poll(() => existsSync(resolve(keyring.home, 'writer-pid')))
      .toBe(true);
    const writer = (
      await readFile(resolve(keyring.home, 'writer-pid'), 'utf8')
    ).trim();
    const relay = JSON.parse(
      await readFile(resolve(keyring.home, 'relay-launch'), 'utf8'),
    ) as { pid: number };
    expect(
      (await keyring.command('/bin/kill', ['-0', writer]).done).status,
    ).toBe(0);
    expect(
      (await keyring.command('/bin/kill', ['-0', String(relay.pid)]).done)
        .status,
    ).toBe(0);
    expect(
      (
        await keyring.command('/bin/sh', [
          '-c',
          'printf x > "$1"',
          'fixture',
          release,
        ]).done
      ).status,
    ).toBe(0);
    await expect
      .poll(
        async () =>
          (await readFile(resolve(keyring.home, 'output'), 'utf8')) ===
          before + (destination === 'background' ? after : ''),
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          (await keyring.command('/bin/kill', ['-0', String(relay.pid)]).done)
            .status,
      )
      .not.toBe(0);
    if (destination === 'background-separate')
      expect(
        await readFile(resolve(keyring.home, 'output-error'), 'utf8'),
      ).toBe(after);
    await expect
      .poll(
        async () =>
          (await keyring.command('/bin/kill', ['-0', writer]).done).status,
      )
      .not.toBe(0);
  },
);
it.each(['padded', 'unpadded'])(
  'Masking E16: flush has a finite byte boundary while a continuous background writer stays masked (%s)',
  async (record) => {
    await writeFile(
      resolve(keyring.home, 'continuous-output'),
      JSON.stringify({
        record,
        maximumTailBytes: Buffer.byteLength(app.input.value),
      }),
    );
    expect(
      (
        await keyring.command(
          '/usr/bin/mkfifo',
          ['refill-requests', 'refill-replies', 'writer-ready'].map((name) =>
            resolve(keyring.home, name),
          ),
        ).done
      ).status,
    ).toBe(0);
    const result = await outputProbe(
      'continuous-background',
      maskingArgs('continuous-background', [keyring.home]),
    );
    const writer = (
      await readFile(resolve(keyring.home, 'writer-pid'), 'utf8')
    ).trim();
    const relay = JSON.parse(
      await readFile(resolve(keyring.home, 'relay-launch'), 'utf8'),
    ) as { pid: number };
    try {
      expect(result.status).toBe(3);
      expect(
        existsSync(resolve(keyring.home, 'flush-overrun')),
        'Flush must acknowledge a finite FIFO byte boundary.',
      ).toBe(false);
      expect(existsSync(resolve(keyring.home, 'writer-flowing'))).toBe(true);
      expect(
        (await keyring.command('/bin/kill', ['-0', writer]).done).status,
      ).toBe(0);
      const snapshot = await readFile(
        resolve(keyring.home, 'exit-snapshot'),
        'utf8',
      );
      expect(snapshot.startsWith(`before:${marker}\n`)).toBe(true);
      expectNoValue(snapshot, [app.input.value]);
    } finally {
      await keyring.command('/bin/kill', ['-TERM', writer]).done;
    }
    await expect
      .poll(
        async () =>
          (await keyring.command('/bin/kill', ['-0', String(relay.pid)]).done)
            .status,
      )
      .not.toBe(0);
    await expect
      .poll(
        async () =>
          (await keyring.command('/bin/kill', ['-0', writer]).done).status,
      )
      .not.toBe(0);
    const output = await readFile(resolve(keyring.home, 'output'), 'utf8');
    expect(output.endsWith(`after:${marker}`)).toBe(true);
    expectNoValue(output, [app.input.value]);
  },
);
it('Masking E17: the complete MiB including its final value is delivered before run exits', async () => {
  const result = await outputProbe('binary', maskingArgs('large'));
  expect(result.status).toBe(0);
  const expected = Buffer.concat([
    Buffer.alloc(1024 * 1024 - Buffer.byteLength(app.input.value), 120),
    Buffer.from(marker),
  ]);
  expect(result.stdout.equals(expected)).toBe(true);
});
it.each([false, true])(
  'Masking E18: Nook failures never print values even with opt-out %s',
  async (disabled) => {
    const command = resolve(keyring.home, 'bad-interpreter');
    await writeFile(command, '#!/nook-fixture-absent\n', { mode: 0o700 });
    const args = runArgs([command]);
    if (disabled) args.splice(1, 0, '--no-masking');
    const result = await keyring.start(args).done;
    expect(result.status).toBe(127);
    expectOutput(
      result.stdout + result.stderr,
      `Command not found: ${command}`,
      true,
    );
    expectNoValue(result.stdout + result.stderr, [
      app.input.value,
      app.key,
      app.token,
    ]);
  },
);
it('Masking E18: a relay lost during value delivery refuses the child with fixed private output', async () => {
  await writeFile(resolve(keyring.home, 'break-delivery'), '');
  const started = resolve(keyring.home, 'started');
  const result = await keyring.start(
    maskingArgs('mark', [started]),
    relaySeam(),
  ).done;
  expect(result.status).toBe(1);
  expect(existsSync(started)).toBe(false);
  expectOutput(
    result.stdout + result.stderr,
    'Nook could not deliver values to output masking. Try again.',
    true,
  );
  expectNoValue(result.stdout + result.stderr, [
    app.input.value,
    app.key,
    app.token,
  ]);
});
it.each(['refuse-relay', 'unavailable-relay'])(
  'Masking E19: relay startup failure precedes the value request and Audit (%s)',
  async (seam) => {
    await writeFile(resolve(keyring.home, seam), '');
    const transport = await valueTransport();
    try {
      const started = resolve(keyring.home, 'started');
      const result = await keyring.start(
        maskingArgs('mark', [started]),
        relaySeam(),
      ).done;
      expect(result.status).toBe(1);
      expectOutput(
        result.stdout + result.stderr,
        'Nook could not start output masking. Try again.',
        true,
      );
      expect(transport.counts).toEqual([]);
      expect(await auditRows(app)).toEqual([]);
      expect(existsSync(started)).toBe(false);
      expectNoValue(result.stdout + result.stderr, [
        app.input.value,
        app.key,
        app.token,
      ]);
    } finally {
      await transport.close();
    }
  },
);
it('Masking E20: relay argv and environment exclude new and already inherited values', async () => {
  const result = await keyring.start(
    maskingArgs('relay-private', [keyring.home]),
    {
      ...relaySeam(),
      GH_TOKEN: app.input.value,
      NOOK_TEST_INHERITED: randomBytes(24).toString('hex'),
    },
  ).done;
  expect(result.status).toBe(0);
  expectOutput(result.stdout, 'true', true);
  expect(result.stderr).toBe('');
  if (process.env.COVERAGE_RUN) {
    const launch = JSON.parse(
      await readFile(resolve(keyring.home, 'relay-launch'), 'utf8'),
    ) as { env: NodeJS.ProcessEnv };
    const file = launch.env.NOOK_CLI_COVERAGE ?? '';
    expect(file.endsWith('-relay.json')).toBe(true);
    await expect.poll(() => existsSync(file)).toBe(true);
    const coverage = JSON.parse(await readFile(file, 'utf8')) as {
      seam: string;
      counters: Record<string, { f: Record<string, number> }>;
    };
    expect(coverage.seam).toBe('cli');
    expect(
      Object.values(coverage.counters['apps/cli/src/relay.ts'].f).some(
        (count) => count > 0,
      ),
    ).toBe(true);
  }
});
it('Masking E1/E20: the SEA executable starts its own relay and masks pipe output', async () => {
  const directory = resolve(keyring.home, 'sea');
  await mkdir(directory);
  const executable = await buildExecutable(directory);
  const result = await keyring.command(
    executable,
    maskingArgs('print-value', ['42']),
  ).done;
  expect(result.status).toBe(42);
  expectOutput(result.stdout, `token=${marker}`, true);
  expect(result.stderr).toBe('');
});
it('Masking E18: the relay itself reports a fixed failure without protocol values', async () => {
  await writeFile(resolve(keyring.home, 'break-protocol'), '');
  const result = await keyring.start(maskingArgs('print-value'), relaySeam())
    .done;
  expect(result.status).toBe(1);
  expectOutput(result.stderr, 'Nook output masking failed.', true);
  expectOutput(
    result.stdout,
    'Nook could not deliver values to output masking. Try again.',
    true,
  );
  expectNoValue(result.stdout + result.stderr, [
    app.input.value,
    app.key,
    app.token,
  ]);
});
it('Masking E1/E20: FIFO creation uses PATH without inherited or injected values', async () => {
  await writeFile(
    resolve(keyring.shim, 'mkfifo'),
    '#!/bin/sh\nif [ "$#" -ne 3 ] || [ "$1" != "-m" ] || [ "$2" != "600" ] || [ -n "$GH_TOKEN" ]; then exit 1; fi\nprintf "private\\n" >> fifo-calls\nexec /usr/bin/mkfifo "$@"\n',
    { mode: 0o700 },
  );
  const result = await keyring.start(maskingArgs('print-value', ['42']), {
    GH_TOKEN: app.input.value,
  }).done;
  expect(result.status).toBe(42);
  expectOutput(result.stdout, `token=${marker}`, true);
  expect(result.stderr).toBe('');
  expect(await readFile(resolve(keyring.home, 'fifo-calls'), 'utf8')).toBe(
    'private\nprivate\n',
  );
});
it.each(['missing', 'refused'])(
  'Masking E19: a %s FIFO command fails privately before requesting values',
  async (failure) => {
    if (failure === 'refused')
      await writeFile(
        resolve(keyring.shim, 'mkfifo'),
        '#!/bin/sh\nprintf "fixture-mkfifo-failure\\n"\nprintf "fixture-mkfifo-failure\\n" >&2\nexit 1\n',
        { mode: 0o700 },
      );
    const transport = await valueTransport();
    try {
      const started = resolve(keyring.home, 'started');
      const result = await keyring.start(maskingArgs('mark', [started]), {
        PATH: keyring.shim,
      }).done;
      expect(result.status).toBe(1);
      expectOutput(
        result.stdout + result.stderr,
        'Nook could not start output masking. Try again.',
        true,
      );
      expect(transport.counts).toEqual([]);
      expect(await auditRows(app)).toEqual([]);
      expect(existsSync(started)).toBe(false);
      expectNoValue(result.stdout + result.stderr, [
        app.input.value,
        app.key,
        app.token,
      ]);
    } finally {
      await transport.close();
    }
  },
);
it('Masking E19: an unusable FIFO directory fails privately before requesting values', async () => {
  const invalid = resolve(keyring.home, 'runtime/not-directory');
  await writeFile(invalid, 'fixture');
  const started = resolve(keyring.home, 'started');
  const result = await keyring.start(maskingArgs('mark', [started]), {
    TMPDIR: invalid,
  }).done;
  expect(result.status).toBe(1);
  expectOutput(
    result.stdout + result.stderr,
    'Nook could not start output masking. Try again.',
    true,
  );
  expect(await auditRows(app)).toEqual([]);
  expect(existsSync(started)).toBe(false);
  expectNoValue(result.stdout + result.stderr, [
    app.input.value,
    app.key,
    app.token,
  ]);
});
