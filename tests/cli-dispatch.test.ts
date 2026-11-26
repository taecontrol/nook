import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeEach, expect, it } from 'vitest';
import { type PrivateKeyring, privateKeyring } from './support/cli.ts';
import { expectOutput } from './support/private-assertions.ts';

let keyring: PrivateKeyring;
beforeEach(async () => {
  keyring = await privateKeyring();
  return () => keyring.close();
});
const createUsage =
  'nook vault create <bucket>/<NAME> --purpose "…" [--description "…"]';
const importUsage = 'nook vault import <bucket> <file> --purpose "…"';
const listUsage = 'nook vault list <bucket>';
const vaultUsage = `nook vault check | ${listUsage} | ${createUsage} | ${importUsage}`;

it.each([
  { args: ['vault', 'list'], usage: listUsage },
  { args: ['vault', 'create'], usage: createUsage },
  { args: ['vault', 'import'], usage: importUsage },
])(
  'Incomplete grammar path $args emits only its usage on stdout',
  async ({ args, usage }) => {
    const result = await keyring.start(args).done;
    expect(result.status).toBe(1);
    expectOutput(result.stdout, `Usage: ${usage}`, true);
    expectOutput(result.stderr, '', true);
    expect(
      await readFile(resolve(keyring.home, 'argv'), 'utf8').catch(() => ''),
    ).toBe('');
  },
);

it.each([
  { args: ['vault'], help: ['vault', '--help'], usage: vaultUsage },
  {
    args: ['vault', 'list', 'work/acme', 'extra'],
    help: ['vault', 'list', '--help'],
    usage: listUsage,
  },
])(
  'Effect parser failure $args retains help followed by usage',
  async ({ args, help, usage }) => {
    const document = await keyring.start(help).done;
    const result = await keyring.start(args).done;
    expect(document.status).toBe(0);
    expect(result.status).toBe(1);
    expectOutput(result.stdout, `${document.stdout}Usage: ${usage}`, true);
    expectOutput(result.stderr, '', true);
  },
);

const readOnlyActions = ['create', 'import'].flatMap((command) => {
  const positional =
    command === 'create' ? ['work/acme/TOKEN'] : ['work/acme', 'unread.env'];
  return ['--help', '-h', '--version', '-v'].flatMap((action) =>
    [[], positional, [...positional, '--purpose', '-h']].map((before) => ({
      command,
      args: ['vault', command, ...before, action],
      version: action === '--version' || action === '-v',
    })),
  );
});
it.each([
  ...readOnlyActions,
  { command: 'list', args: ['vault', 'list', '--help'], version: false },
])(
  'Read-only action $args reaches effect/cli without reading secret input or keyring',
  async ({ command, args, version }) => {
    const document = await keyring.start(
      version ? ['--version'] : ['vault', command, '--help'],
    ).done;
    expect(document.status).toBe(0);
    expectOutput(document.stdout, version ? 'nook v' : `nook vault ${command}`);
    if (!version) expectOutput(document.stdout, '--help, -h');
    const result = await keyring.start(args, {}, 'synthetic-dispatch-value\n')
      .done;
    expect(result.status).toBe(0);
    expectOutput(result.stdout, document.stdout.trim(), true);
    expectOutput(document.stderr, '', true);
    expectOutput(result.stderr, '', true);
    expect(
      await readFile(resolve(keyring.home, 'argv'), 'utf8').catch(() => ''),
    ).toBe('');
  },
);

it.each([
  ...['--help', '-h', '--version', '-v'].map((value) => ({
    args: ['vault', 'create', 'work/acme/TOKEN', '--purpose', value],
    message: 'Enter a value.',
  })),
  ...['--help', '-h'].map((value) => ({
    args: [
      'vault',
      'create',
      'work/acme/TOKEN',
      '--purpose',
      'test',
      '--description',
      value,
    ],
    message: 'Enter a value.',
  })),
  ...['--help', '-h'].map((file) => ({
    args: ['vault', 'import', 'work/acme', file, '--purpose', 'test'],
    message: `Could not read ${file}.`,
  })),
  {
    args: [
      'vault',
      'import',
      'work/acme',
      'unread.env',
      '--purpose',
      '--version',
    ],
    message: 'Could not read unread.env.',
  },
])('Literal action token in $args remains data', async ({ args, message }) => {
  const result = await keyring.start(args).done;
  expect(result.status).toBe(1);
  expectOutput(result.stdout, message, true);
  expectOutput(result.stderr, '', true);
  expect(
    await readFile(resolve(keyring.home, 'argv'), 'utf8').catch(() => ''),
  ).toBe('');
});

it('vault help lists its subcommands in the order of the vault usage', async () => {
  const result = await keyring.start(['vault', '--help']).done;
  const subcommands = result.stdout
    .split('SUBCOMMANDS\n')[1]
    ?.split('\n')
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean);
  expect(result.status).toBe(0);
  expect(subcommands).toEqual(['check', 'list', 'create', 'import']);
});
