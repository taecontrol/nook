import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { delimiter, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { testEnvironment } from '../scripts/lib/test-environment.ts';

it.each(['missing', 'present', 'list-failed'])(
  'file deployment provisions only the configured missing bucket: %s',
  async (initial) => {
    const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
    const bucket = config.r2_buckets.find(
      (binding: { binding: string }) => binding.binding === 'FILES',
    ).bucket_name;
    const workflow = parse(
      await readFile('.github/workflows/deploy.yml', 'utf8'),
    );
    const step = workflow.jobs.deploy.steps.find(
      (value: { name?: string }) =>
        value.name === 'Provision configured file storage',
    );
    expect(step).toBeDefined();
    const directory = await mkdtemp(resolve('.local', 'file-deploy-'));
    try {
      await mkdir(resolve(directory, 'home'));
      const calls = resolve(directory, 'calls.json');
      await writeFile(calls, '[]');
      await writeFile(
        resolve(directory, 'pnpm'),
        `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const args=process.argv.slice(2);
const calls=JSON.parse(readFileSync(${JSON.stringify(calls)}, 'utf8'));
calls.push(args); writeFileSync(${JSON.stringify(calls)},JSON.stringify(calls));
if (args.at(-1)==='list') {
  if (${JSON.stringify(initial)}==='list-failed') process.exit(1);
  console.log('name: unrelated-bucket\\ncreation_date: 2026-10-01');
  if (${JSON.stringify(initial)}==='present') console.log('name: ${bucket}\\ncreation_date: 2026-10-01');
}
`,
      );
      await chmod(resolve(directory, 'pnpm'), 0o755);
      const shell = `export CLOUDFLARE_ACCOUNT_ID=synthetic-account CLOUDFLARE_API_TOKEN=synthetic-fixture\n${step.run}`;
      const result = spawnSync('bash', ['-e', '-c', shell], {
        env: testEnvironment(resolve(directory, 'home'), {
          PATH: `${directory}${delimiter}${process.env.PATH}`,
        }),
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.status).toBe(initial === 'list-failed' ? 1 : 0);
      expect(JSON.parse(await readFile(calls, 'utf8'))).toEqual([
        ['exec', 'wrangler', 'r2', 'bucket', 'list'],
        ...(initial === 'missing'
          ? [['exec', 'wrangler', 'r2', 'bucket', 'create', bucket]]
          : []),
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
