import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import {
  temporaryTestHome,
  testEnvironment,
} from '../scripts/lib/test-environment.ts';
import {
  refusedVerification,
  verificationWorkspace,
} from './support/verification-command.ts';

it.each(['login', 'whoami', 'logout', 'mcp-header'])(
  'E15: %s on unsupported platforms exits without a request',
  async (command) => {
    const path = '../apps/cli/src/commands.ts';
    const { execute } = await import(path);
    const fetch = vi.spyOn(globalThis, 'fetch');
    const output: string[] = [];
    try {
      const status = await execute(
        command === 'login' ? [command, 'https://nook.test'] : [command],
        {
          platform: 'win32',
          write: (message: string) => output.push(message),
        },
      );
      expect(status).toBe(1);
      expect(output.join('\n')).toBe(
        'The Nook CLI supports Linux and macOS only.',
      );
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  },
);

it.runIf(process.platform === 'darwin').each([
  ['pnpm verify', 'scripts/verify.ts', []],
  ['pnpm test:coverage', 'scripts/coverage.ts', []],
  ['pnpm test:coverage', 'scripts/coverage.ts', ['--shard=1/10']],
] as const)(
  '#87 E1/E2/E6: %s %j refuses before isolation, children, builds or evidence changes',
  async (command, entrypoint, args) => {
    const home = await temporaryTestHome();
    try {
      const observed = await refusedVerification(home, entrypoint, [...args]);
      expect.soft(observed.result.error).toBeUndefined();
      expect.soft(observed.result.signal).toBeNull();
      expect.soft(observed.result.status).toBe(1);
      expect
        .soft(observed.result.stderr)
        .toContain(
          `${command} runs on Linux. On macOS, CI's macos-cli job runs the macOS suites; run the full check on Linux or push and let CI decide.`,
        );
      expect.soft(observed.result.stdout).toBe('');
      expect
        .soft(observed.result.stdout + observed.result.stderr)
        .not.toMatch(/\b(?:passed|succeeded|success(?:ful(?:ly)?)?)\b/i);
      expect.soft(observed.observations).toBe('');
      expect.soft(observed.after).toEqual(observed.before);
      expect
        .soft(observed.evidence)
        .toEqual(['{"synthetic":"baseline"}', '{"synthetic":"execution"}']);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

it.runIf(process.platform === 'darwin')(
  '#87 E5: narrow tests and individual verification stages still run on macOS',
  async () => {
    const home = await temporaryTestHome();
    try {
      const cwd = await verificationWorkspace(home);
      for (const args of [
        ['test', 'tests/macos-keyring-policy.test.ts'],
        ['verify:types'],
      ]) {
        const result = spawnSync('pnpm', args, {
          cwd,
          env: testEnvironment(home, { COVERAGE_RUN: undefined }),
          encoding: 'utf8',
          timeout: 60_000,
        });
        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status, result.stdout + result.stderr).toBe(0);
        if (args[0] === 'test') expect(result.stdout).toContain('Tests');
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  150_000,
);

it.each([
  [['--shard=1/6'], 'Expected --shard=I/10 with I between 1 and 10.'],
  [['--macos-cli'], 'Expected --macos-cli=I/2.'],
  [
    ['--macos-cli=3/2'],
    '--macos-cli=I/2 requires macOS without a Linux shard.',
  ],
  [
    ['--macos-cli=1/2', '--shard=1/10'],
    '--macos-cli=I/2 requires macOS without a Linux shard.',
  ],
  ...(process.platform === 'linux'
    ? ['1/2', '2/2'].map(
        (shard) =>
          [
            [`--macos-cli=${shard}`],
            '--macos-cli=I/2 requires macOS without a Linux shard.',
          ] as const,
      )
    : []),
] as const)(
  '#87: coverage keeps its existing argument refusal for %j',
  async (args, message) => {
    const home = await temporaryTestHome();
    try {
      const observed = await refusedVerification(home, 'scripts/coverage.ts', [
        ...args,
      ]);
      expect(observed.result.error).toBeUndefined();
      expect(observed.result.status).toBe(1);
      expect(observed.result.stderr).toContain(message);
      expect(observed.result.stdout).toBe('');
      expect(observed.observations).toBe('');
      expect(observed.after).toEqual(observed.before);
      expect(observed.evidence).toEqual([
        '{"synthetic":"baseline"}',
        '{"synthetic":"execution"}',
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
