import { spawnSync } from 'node:child_process';
import { verificationStages } from './verification-stages.ts';

for (const stage of verificationStages) {
  const result = spawnSync('pnpm', [stage], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
