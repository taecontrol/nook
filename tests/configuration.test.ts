import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import {
  macosCliGroups,
  macosCliSuites,
} from '../scripts/lib/macos-cli-suites.ts';

const expression = (value: string) => ['$', '{{ ', value, ' }}'].join('');

async function workflow(name: string) {
  const path = `.github/workflows/${name}.yml`;
  expect(existsSync(path), `Missing ${name} workflow`).toBe(true);
  return parse(await readFile(path, 'utf8'));
}

it('E5: committed Worker and deploy settings contain no installation identifiers or synthetic owner', async () => {
  expect(existsSync('wrangler.jsonc'), 'Missing Worker configuration').toBe(
    true,
  );
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  const forbidden = [
    'account_id',
    'routes',
    'custom_domain',
    'database_id',
    'LOCAL_OWNER',
    'LOCAL_ORIGIN',
  ];
  const visit = (object: unknown) => {
    if (!object || typeof object !== 'object') return;
    for (const [key, value] of Object.entries(object)) {
      expect(forbidden).not.toContain(key);
      visit(value);
    }
  };
  visit(config);
  const deploy = await readFile('scripts/lib/deploy.ts', 'utf8');
  expect(deploy).not.toMatch(
    /LOCAL_OWNER|LOCAL_ORIGIN|synthetic-owner|owner@nook\.test/,
  );
  expect(config.workers_dev).toBe(false);
  expect(config.preview_urls).toBe(false);
});

it('installation E8: Workers observability is enabled', async () => {
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  expect(config.observability?.enabled).toBe(true);
});

it('installation E6: automatic invocation logs cannot record request query strings', async () => {
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  expect(config.observability?.logs?.invocation_logs).toBe(false);
});

it('E17/#33 E21: PR CI requires static checks, ten Linux shards, macOS CLI and the final coverage/build/budget gate without Cloudflare credentials', async () => {
  const ci = await workflow('verify');
  expect(ci.on).toHaveProperty('pull_request');
  expect(
    ci.jobs['static-checks'].steps
      .filter((step: { run?: string }) => step.run?.startsWith('pnpm verify:'))
      .map((step: { run: string }) => step.run),
  ).toEqual([
    'pnpm verify:style',
    'pnpm verify:ui',
    'pnpm verify:types',
    'pnpm verify:complexity',
    'pnpm verify:migrations',
  ]);
  expect(ci.jobs.tests.strategy.matrix.shard).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
  ]);
  expect(
    ci.jobs.tests.steps.some(
      (step: { run?: string }) =>
        step.run ===
        `pnpm test:coverage --shard=${expression('matrix.shard')}/10`,
    ),
  ).toBe(true);
  const final = ci.jobs.verify;
  expect(final.needs).toEqual([
    'static-checks',
    'tests',
    'macos-cli',
    'linux-binary',
  ]);
  const macos = ci.jobs['macos-cli'];
  expect(macos['runs-on']).toBe('macos-latest');
  expect(macos['timeout-minutes']).toBe(15);
  expect(macos.strategy.matrix.shard).toEqual([1, 2]);
  expect(macos.env.NOOK_TEST_MACOS_KEYCHAIN_BOOTSTRAP).toBe('github-hosted');
  expect(
    macos.steps.some(
      (step: { run?: string }) =>
        step.run ===
        `pnpm test:coverage --macos-cli=${expression('matrix.shard')}/2`,
    ),
  ).toBe(true);
  // Each suite runs in exactly one macOS shard.
  expect(new Set(macosCliSuites).size).toBe(macosCliSuites.length);
  expect(macosCliGroups.every((group) => group.length > 0)).toBe(true);
  expect(macosCliSuites).toEqual(
    expect.arrayContaining([
      'tests/vault-cli.test.ts',
      'tests/macos-keyring-policy.test.ts',
      'tests/macos-boundary-policy.test.ts',
    ]),
  );
  expect(
    macos.steps.some(
      (step: { with?: { name?: string } }) =>
        step.with?.name === `coverage-macos-${expression('matrix.shard')}`,
    ),
  ).toBe(true);
  expect(ci.env?.NOOK_TEST_MACOS_KEYCHAIN_BOOTSTRAP).toBeUndefined();
  for (const [name, job] of Object.entries(ci.jobs) as [
    string,
    { env?: Record<string, string> },
  ][]) {
    if (name !== 'macos-cli')
      expect(job.env?.NOOK_TEST_MACOS_KEYCHAIN_BOOTSTRAP).toBeUndefined();
  }
  const commands = final.steps
    .filter((step: { run?: string }) => step.run)
    .map((step: { run: string }) => step.run);
  expect(commands).toContain('pnpm verify:crap');
  expect(commands).toContain('pnpm build');
  expect(commands).toContain('pnpm verify:load-time');
  expect(commands.indexOf('pnpm build')).toBeGreaterThan(
    commands.indexOf('pnpm verify:crap'),
  );
  expect(commands.indexOf('pnpm verify:load-time')).toBeGreaterThan(
    commands.indexOf('pnpm build'),
  );
  for (const job of Object.values(ci.jobs) as {
    steps: { uses?: string; with?: { 'fetch-depth'?: number } }[];
  }[]) {
    expect(
      job.steps.find((step) => step.uses?.startsWith('actions/checkout@'))
        ?.with?.['fetch-depth'],
    ).toBe(0);
  }
  expect(
    commands.some((command: string) => command.includes('coverage:merge')),
  ).toBe(true);
  expect(JSON.stringify(ci)).not.toMatch(
    /secrets\.|vars\.CLOUDFLARE|vars\.NOOK_HOSTNAME/,
  );
});

it.each([
  ['1', 'read-only'],
  ['', 'read-write'],
])('E13: CI=%s selects %s replay with zero retries', async (ci, mode) => {
  vi.stubEnv('CI', ci);
  vi.resetModules();
  try {
    // Constructing the model does not read credentials or call it.
    const { default: configuration } = await import('../e2e.config.ts');
    expect(configuration.retries).toBe(0);
    expect(configuration.cache.mode).toBe(mode);
  } finally {
    vi.unstubAllEnvs();
  }
});

it('E13: both journey entry points require strict cache replay', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  expect(manifest.scripts['test:journey'].split(/\s+/)).toEqual([
    'node',
    'scripts/journey.ts',
  ]);
  expect(await readFile('scripts/journey.ts', 'utf8')).toMatch(
    /(['"])e2e\1,\s*(['"])run\2,\s*(['"])--strict-cache\3/,
  );
  const coverage = await readFile('scripts/coverage.ts', 'utf8');
  expect(coverage).toMatch(
    /(['"])e2e\1,\s*(['"])run\2,\s*(['"])--strict-cache\3/,
  );
});

it('CI holds no Cloudflare credential and never deploys', async () => {
  const directory = '.github/workflows';
  for (const name of await readdir(directory)) {
    const text = await readFile(`${directory}/${name}`, 'utf8');
    expect(text, name).not.toMatch(
      /CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|NOOK_HOSTNAME|wrangler (deploy|d1|r2|vectorize|secret)/,
    );
  }
});

it('E23: the Worker binds Workers AI, the memory index and the five-minute Cron', async () => {
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  expect(config.ai).toEqual({ binding: 'AI' });
  expect(config.vectorize).toEqual([
    { binding: 'MEMORY_INDEX', index_name: 'nook-memories' },
  ]);
  expect(config.triggers.crons).toEqual(['*/5 * * * *']);
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

it('E26: CLI enters complexity and coverage scope, and CI installs a real Secret Service', async () => {
  const config = JSON.parse(await readFile('coverage.config.json', 'utf8'));
  expect(config.roots).toContain('apps/cli/src');
  expect(config.complexityRoots).toContain('apps/cli/src');
  const commands = (await workflow('verify')).jobs.tests.steps
    .map((step: { run?: string }) => step.run ?? '')
    .join('\n');
  for (const dependency of ['gnome-keyring', 'libsecret-tools', 'dbus'])
    expect(commands).toContain(dependency);
});

it('E12: every CI test shard runs on Ubuntu 26.04 and installs bubblewrap before coverage, with no other privileged command', async () => {
  const ci = await workflow('verify');
  expect(ci.jobs.tests['runs-on']).toBe('ubuntu-26.04');
  const commands: string[] = ci.jobs.tests.steps.map(
    (step: { run?: string }) => step.run ?? '',
  );
  const install = commands.findIndex((command) =>
    /apt-get install.*\bbubblewrap\b/.test(command),
  );
  const coverage = commands.findIndex((command) =>
    command.startsWith('pnpm test:coverage'),
  );
  expect(install).toBeGreaterThanOrEqual(0);
  expect(coverage).toBeGreaterThan(install);
  expect(ci.jobs.tests.strategy.matrix.shard).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
  ]);
  // Ubuntu's own bwrap profile must stay as the image ships it.
  expect(commands.filter((command) => command.includes('sudo'))).toEqual([
    'sudo apt-get update && sudo apt-get install -y bubblewrap gnome-keyring libsecret-tools dbus',
  ]);
  const policy = await readFile('.github/apparmor/nook-bwrap', 'utf8');
  expect(policy.replace(/\s+/g, ' ').trim()).toBe(
    'abi <abi/4.0>, include <tunables/global> profile nook-bwrap /usr/bin/bwrap flags=(unconfined) { userns, }',
  );
});
