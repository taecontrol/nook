import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

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
  const deploy = await workflow('deploy');
  expect(JSON.stringify(deploy)).not.toMatch(
    /LOCAL_OWNER|LOCAL_ORIGIN|synthetic-owner|owner@nook\.test/,
  );
  expect(config.workers_dev).toBe(false);
  expect(config.preview_urls).toBe(false);
});

it('E17: PR CI runs static checks, three test shards and a final coverage/build/budget gate without Cloudflare credentials', async () => {
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
  ]);
  expect(ci.jobs.tests.strategy.matrix.shard).toEqual([1, 2, 3]);
  expect(
    ci.jobs.tests.steps.some(
      (step: { run?: string }) =>
        step.run ===
        `pnpm test:coverage --shard=${expression('matrix.shard')}/3`,
    ),
  ).toBe(true);
  const final = ci.jobs.verify;
  expect(final.needs).toEqual(['static-checks', 'tests']);
  const commands = final.steps
    .filter((step: { run?: string }) => step.run)
    .map((step: { run: string }) => step.run);
  expect(commands).toContain('pnpm verify:crap');
  expect(commands).toContain('pnpm build');
  expect(commands).toContain('pnpm verify:bundle');
  expect(
    commands.some((command: string) => command.includes('coverage:merge')),
  ).toBe(true);
  expect(JSON.stringify(ci)).not.toMatch(
    /secrets\.|vars\.CLOUDFLARE|vars\.NOOK_HOSTNAME/,
  );
});

it('E20 setup: deployment is manual, main-only, verifies first and reads the installation settings from GitHub', async () => {
  const deploy = await workflow('deploy');
  expect(Object.keys(deploy.on)).toEqual(['workflow_dispatch']);
  expect(deploy.jobs.deploy.if).toBe("github.ref == 'refs/heads/main'");
  const steps = deploy.jobs.deploy.steps;
  const commands = steps
    .filter((step: { run?: string }) => step.run)
    .map((step: { run: string }) => step.run);
  expect(commands.indexOf('pnpm verify')).toBeGreaterThan(-1);
  const publish = commands.findIndex((command: string) =>
    command.includes('wrangler deploy'),
  );
  expect(publish).toBeGreaterThan(commands.indexOf('pnpm verify'));
  expect(commands[publish]).toContain('--domain "$NOOK_HOSTNAME"');
  const env = steps.find((step: { run?: string }) =>
    step.run?.includes('wrangler deploy'),
  ).env;
  expect(env).toMatchObject({
    CLOUDFLARE_ACCOUNT_ID: expression('vars.CLOUDFLARE_ACCOUNT_ID'),
    NOOK_HOSTNAME: expression('vars.NOOK_HOSTNAME'),
    CLOUDFLARE_API_TOKEN: expression('secrets.CLOUDFLARE_API_TOKEN'),
  });
});

it('E20 setup: the real preflight blocks unless Verify succeeded on the exact main commit', async () => {
  const deploy = await workflow('deploy');
  const preflight = deploy.jobs.deploy.steps.find(
    (step: { name?: string }) => step.name === 'Require green main',
  );
  expect(preflight).toBeDefined();
  const directory = await mkdtemp(resolve('.local', 'green-main-'));
  const argsPath = resolve(directory, 'args.json');
  try {
    const fixture = resolve(directory, 'gh');
    await writeFile(
      fixture,
      '#!/usr/bin/env node\nimport {writeFileSync} from "node:fs"; writeFileSync(process.env.PREFLIGHT_ARGS, JSON.stringify(process.argv.slice(2))); console.log(process.env.PREFLIGHT_COUNT);\n',
    );
    await chmod(fixture, 0o755);
    const environment = {
      ...process.env,
      PATH: `${directory}${delimiter}${process.env.PATH}`,
      GH_TOKEN: undefined,
      GITHUB_REPOSITORY: 'synthetic/nook',
      GITHUB_SHA: 'fixture-main-sha',
      PREFLIGHT_ARGS: argsPath,
    };
    for (const [count, status] of [
      ['0', 1],
      ['1', 0],
    ] as const) {
      const result = spawnSync('bash', ['-c', preflight.run], {
        env: { ...environment, PREFLIGHT_COUNT: count },
        encoding: 'utf8',
        timeout: 5_000,
      });
      expect(result.status).toBe(status);
      expect(JSON.parse(await readFile(argsPath, 'utf8'))).toEqual([
        'run',
        'list',
        '--repo',
        'synthetic/nook',
        '--workflow',
        'verify.yml',
        '--branch',
        'main',
        '--commit',
        'fixture-main-sha',
        '--json',
        'status,conclusion',
        '--jq',
        'map(select(.status == "completed" and .conclusion == "success")) | length',
      ]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
