import { spawnSync } from 'node:child_process';
import { cp } from 'node:fs/promises';
import { buildProduct } from './build.ts';

await buildProduct();
await cp('dist', '.local/test-build', { recursive: true });
const result = spawnSync(
  'pnpm',
  ['exec', 'vitest', 'run', ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
process.exitCode = result.status ?? 1;
