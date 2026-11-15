import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { DeployError, deploy, resources, type Shell } from './lib/deploy.ts';

// Standard input stays closed so Wrangler never prompts. Interactive Wrangler
// would offer to write resource IDs into the committed wrangler.jsonc.
const shell: Shell = {
  show: ([file, ...args]) =>
    spawnSync(file, args, { stdio: ['ignore', 'inherit', 'inherit'] })
      .status === 0,
  read: ([file, ...args], quiet = false) => {
    const result = spawnSync(file, args, {
      stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'inherit'],
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return result.status === 0 ? result.stdout : undefined;
  },
  wait: (milliseconds) => setTimeout(milliseconds),
};

try {
  const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
  const notice = await deploy(process.argv[2], shell, resources(config));
  if (notice) console.error(notice);
} catch (error) {
  if (!(error instanceof DeployError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
}
