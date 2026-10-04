import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { verificationStages } from '../scripts/verification-stages.ts';

it('E21/E22: verify replaces the byte ratchet with sequential migration and load-time stages', async () => {
  expect(verificationStages).toEqual([
    'verify:style',
    'verify:ui',
    'verify:types',
    'verify:complexity',
    'verify:migrations',
    'test:coverage',
    'verify:crap',
    'build',
    'verify:load-time',
  ]);
  expect(existsSync('bundle-budget.json')).toBe(false);
  expect(existsSync('tests/bundle-history.test.ts')).toBe(false);
  expect(await readFile('AGENTS.md', 'utf8')).toContain(
    'stay within the load-time budgets: a cold open shows its first screen within 1 s on a 4G phone network, and navigation after intent within 100 ms',
  );
  expect(await readFile('docs/verification/README.md', 'utf8')).toContain(
    'verify:load-time',
  );
});
it('E23: D1 is bound by name with migrations and no installation ID', async () => {
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  expect(config.d1_databases).toEqual([
    {
      binding: 'DB',
      database_name: 'nook',
      migrations_dir: 'migrations',
      migrations_pattern: 'migrations/[0-9][0-9][0-9][0-9]_+([a-z0-9_]).sql',
    },
  ]);
});
it('E24: deployment builds, creates the missing database, migrates, then deploys', async () => {
  const workflow = parse(
    await readFile('.github/workflows/deploy.yml', 'utf8'),
  );
  const commands = workflow.jobs.deploy.steps
    .filter((step: { run?: string }) => step.run)
    .map((step: { run: string }) => step.run)
    .join('\n');
  const build = commands.indexOf('pnpm build');
  const create = commands.indexOf('wrangler d1 create nook');
  const migrate = commands.indexOf('wrangler d1 migrations apply DB --remote');
  const deploy = commands.indexOf('wrangler deploy');
  expect(build).toBeGreaterThanOrEqual(0);
  expect(create).toBeGreaterThan(build);
  expect(migrate).toBeGreaterThan(create);
  expect(deploy).toBeGreaterThan(migrate);
});
