import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildExecutable } from '../scripts/release/binary.ts';
import { privateKeyring } from './support/cli.ts';

const { version } = JSON.parse(
  await readFile('apps/cli/package.json', 'utf8'),
) as { version: string };

it('E6: nook version prints the package version as JSON and --version names the same version', async () => {
  expect(version).toBe('0.1.0');
  const keyring = await privateKeyring();
  try {
    expect(await keyring.start(['version']).done).toEqual({
      status: 0,
      stdout: '{"version":"0.1.0"}\n',
      stderr: '',
    });
    expect(await keyring.start(['--version']).done).toMatchObject({
      status: 0,
      stdout: 'nook v0.1.0\n',
    });
  } finally {
    await keyring.close();
  }
});

it('E6: apps/cli/package.json is the only source of the CLI version', async () => {
  for (const file of await readdir('apps/cli/src'))
    expect(await readFile(`apps/cli/src/${file}`, 'utf8')).not.toMatch(
      /\d+\.\d+\.\d+/,
    );
});

it('E7: Verify builds the single executable on Linux x64 and macOS arm64 and runs it without Node on PATH', async () => {
  const workflow = parse(
    await readFile('.github/workflows/verify.yml', 'utf8'),
  );
  const linux = workflow.jobs['linux-binary'];
  expect(linux['runs-on']).toBe('ubuntu-24.04');
  for (const job of [linux, workflow.jobs['macos-cli']])
    expect(
      job.steps.map((step: { run?: string }) => step.run ?? '').join('\n'),
    ).toContain('node scripts/release/binary.ts --output "$RUNNER_TEMP/nook"');
  expect(workflow.jobs.verify.needs).toContain('linux-binary');
  const script = await readFile('scripts/release/binary.ts', 'utf8');
  expect(script).toContain("'env', ['-i', 'PATH=/usr/bin:/bin'");
});

it('E7: the single executable reports the package version in an environment without Node', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'nook-sea-'));
  try {
    const executable = await buildExecutable(directory);
    const empty = resolve(directory, 'empty');
    expect(
      spawnSync('/usr/bin/env', ['-i', `PATH=${empty}`, 'node', '--version'])
        .status,
    ).not.toBe(0);
    const result = spawnSync(
      '/usr/bin/env',
      ['-i', `PATH=${empty}`, `HOME=${directory}`, executable, 'version'],
      { encoding: 'utf8' },
    );
    expect(result.stdout).toBe(`{"version":"${version}"}\n`);
    expect(result.status).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
