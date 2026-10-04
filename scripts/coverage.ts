import { spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { buildProduct } from './build.ts';
import { digest, files, sourceIdentity } from './lib/identity.ts';
import { evidenceRoot, prepare } from './lib/instrument.ts';
import { buildTest } from './test-build.ts';

const shard = process.argv
  .find((arg) => arg.startsWith('--shard='))
  ?.slice('--shard='.length);
if (shard !== undefined && !/^[1-3]\/3$/.test(shard))
  throw new Error('Expected --shard=I/3 with I between one and three.');
await rm(evidenceRoot, { recursive: true, force: true });
const before = await sourceIdentity();
await prepare();
await buildProduct();
await buildTest();
for (const args of [
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
    env: { ...process.env, COVERAGE_RUN: '1', E2E_TELEMETRY_DISABLED: '1' },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
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
    { schema: 1, source: before, ...(shard ? { shard } : {}), outputs },
    null,
    2,
  ),
);
