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

it.each(['create', 'import', 'list'])(
  'vault %s --help reaches effect/cli without keyring access',
  async (command) => {
    const result = await keyring.start(['vault', command, '--help']).done;
    expect(result.status).toBe(0);
    expectOutput(result.stdout, `nook vault ${command}`);
    expectOutput(result.stdout, '--help');
    expectOutput(result.stderr, '', true);
    expect(
      await readFile(resolve(keyring.home, 'argv'), 'utf8').catch(() => ''),
    ).toBe('');
  },
);

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
