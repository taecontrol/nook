import { spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { buildProduct } from './build.ts';
import { coverageShards, linuxShards } from './lib/coverage-evidence.ts';
import { startHostIsolation } from './lib/host-isolation.ts';
import { digest, files, sourceIdentity } from './lib/identity.ts';
import { evidenceRoot, prepare } from './lib/instrument.ts';
import { macosCliGroups, macosShards } from './lib/macos-cli-suites.ts';
import { testEnvironment } from './lib/test-environment.ts';
import { requireVerificationPlatform } from './lib/verification-platform.ts';
import { buildTest } from './test-build.ts';

const option = (name: string) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const shard = option('shard');
if (
  shard !== undefined &&
  !coverageShards.slice(0, linuxShards).includes(shard)
)
  throw new Error(
    `Expected --shard=I/${linuxShards} with I between 1 and ${linuxShards}.`,
  );
const macos = option('macos-cli');
if (process.argv.includes('--macos-cli'))
  throw new Error(`Expected --macos-cli=I/${macosShards}.`);
if (
  macos !== undefined &&
  (process.platform !== 'darwin' ||
    shard !== undefined ||
    !coverageShards.includes(`macos-${macos}`))
)
  throw new Error(
    `--macos-cli=I/${macosShards} requires macOS without a Linux shard.`,
  );
requireVerificationPlatform(
  process.platform,
  'pnpm test:coverage',
  macos !== undefined,
);
const isolation = await startHostIsolation();
try {
  await rm(evidenceRoot, { recursive: true, force: true });
  const before = await sourceIdentity();
  await prepare();
  await buildProduct();
  await buildTest();
  for (const args of macos
    ? [
        [
          'exec',
          'vitest',
          'run',
          ...macosCliGroups[Number(macos.split('/')[0]) - 1],
        ],
      ]
    : [
        ['exec', 'vitest', 'run', ...(shard ? [`--shard=${shard}`] : [])],
        [
          'exec',
          'e2e',
          'run',
          '--strict-cache',
          ...(shard ? ['--shard', shard, '--pass-with-no-tests'] : []),
        ],
      ]) {
    const result = spawnSync('pnpm', args, {
      stdio: 'inherit',
      env: testEnvironment(isolation.home, {
        COVERAGE_RUN: '1',
        E2E_TELEMETRY_DISABLED: '1',
      }),
    });
    if (result.status !== 0) throw new Error('Coverage test command failed.');
  }
  const after = await sourceIdentity();
  if (before.digest !== after.digest)
    throw new Error('Source changed during coverage.');
  const outputs: Record<string, string> = {};
  for (const path of await files(evidenceRoot))
    outputs[basename(path)] = digest(await readFile(path));
  await writeFile(
    resolve(evidenceRoot, 'manifest.json'),
    JSON.stringify(
      {
        schema: 1,
        source: before,
        ...(macos ? { shard: `macos-${macos}` } : shard ? { shard } : {}),
        outputs,
      },
      null,
      2,
    ),
  );
} finally {
  await isolation.close();
}
