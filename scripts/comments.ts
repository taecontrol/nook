import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const baseRef = 'origin/main';
const baseline = 'scripts/lint/comment-baseline.json';

const git = (args: string[]) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });

try {
  git(['rev-parse', '--quiet', '--verify', baseRef]);
} catch {
  throw new Error(
    `The comment ratchet compares against ${baseRef}; fetch the base branch first.`,
  );
}
const published = git(['ls-tree', '--name-only', baseRef, '--', baseline])
  ? git(['show', `${baseRef}:${baseline}`])
  : 'null';
mkdirSync('.local', { recursive: true });
writeFileSync('.local/comment-baseline-base.json', published);
const lint = spawnSync(
  'oxlint',
  ['--format', 'default', '-c', '.oxlintrc.comments.json', '.'],
  { stdio: 'inherit' },
);
process.exitCode = lint.status ?? 1;
