import { spawnSync } from 'node:child_process';
import { startHostIsolation } from './lib/host-isolation.ts';
import { testEnvironment } from './lib/test-environment.ts';
import { verificationStages } from './verification-stages.ts';

const isolation = await startHostIsolation();
try {
  for (const stage of verificationStages) {
    const result = spawnSync('pnpm', [stage], {
      env: testEnvironment(isolation.home),
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
} finally {
  await isolation.close();
}
