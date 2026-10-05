import { spawnSync } from 'node:child_process';
import { startHostIsolation } from './lib/host-isolation.ts';
import { testEnvironment } from './lib/test-environment.ts';

const isolation = await startHostIsolation();
try {
  const result = spawnSync(
    'pnpm',
    ['exec', 'e2e', 'run', '--strict-cache', ...process.argv.slice(2)],
    {
      env: testEnvironment(isolation.home, { E2E_TELEMETRY_DISABLED: '1' }),
      stdio: 'inherit',
    },
  );
  process.exitCode = result.status ?? 1;
} finally {
  await isolation.close();
}
