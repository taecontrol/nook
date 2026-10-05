import { spawnSync } from 'node:child_process';
import { cp } from 'node:fs/promises';
import { buildProduct } from './build.ts';
import { startHostIsolation } from './lib/host-isolation.ts';
import { testEnvironment } from './lib/test-environment.ts';

const isolation = await startHostIsolation();
try {
  await buildProduct();
  await cp('dist', '.local/test-build', { recursive: true });
  const result = spawnSync(
    'pnpm',
    ['exec', 'vitest', 'run', ...process.argv.slice(2)],
    { env: testEnvironment(isolation.home), stdio: 'inherit' },
  );
  process.exitCode = result.status ?? 1;
} finally {
  await isolation.close();
}
