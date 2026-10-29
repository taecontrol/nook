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

const requiredSecrets = [
  'ACCESS_ISSUER',
  'ACCESS_AUDIENCE',
  'OWNER_EMAIL',
  'VAULT_KEY',
];

it.each([
  ['none', 'file'],
  ['issuer-only', 'file'],
  ['complete', 'file'],
  ['list-failed', 'file'],
  ['deploy-failed', 'file'],
  ['none', 'directory'],
  ['list-failed', 'directory'],
])(
  'installation E9: the real deploy shell checks secret names without changing its result: %s, summary %s',
  async (state, summaryKind) => {
    const workflow = parse(
      await readFile('.github/workflows/deploy.yml', 'utf8'),
    );
    const step = workflow.jobs.deploy.steps.find((s: { run?: string }) =>
      s.run?.includes('wrangler deploy'),
    );
    const directory = await mkdtemp(resolve('.local', 'installation-deploy-'));
    const calls = resolve(directory, 'calls.json');
    const summary = resolve(directory, 'summary.md');
    try {
      await mkdir(resolve(directory, 'home'));
      await writeFile(calls, '[]');
      if (summaryKind === 'directory') await mkdir(summary);
      else await writeFile(summary, '');
      await writeFile(
        resolve(directory, 'pnpm'),
        `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const calls = JSON.parse(readFileSync(${JSON.stringify(calls)}, 'utf8'));
calls.push(args); writeFileSync(${JSON.stringify(calls)}, JSON.stringify(calls));
const command = args.slice(2, 4).join(' ');
if (command === 'd1 list') console.log(JSON.stringify([{ name: 'nook' }]));
else if (command === 'd1 migrations') {}
else if (command === 'vectorize list') console.log(JSON.stringify([{ name: 'nook-memories' }]));
else if (command === 'vectorize list-metadata-index') console.log(JSON.stringify([{ propertyName: 'bucket', indexType: 'String' }]));
else if (args[2] === 'deploy') { if (${JSON.stringify(state)} === 'deploy-failed') process.exit(1); }
else if (command === 'secret list') {
  if (${JSON.stringify(state)} === 'list-failed') { console.error('private-command-error-canary'); process.exit(1); }
  const names = ${JSON.stringify(state === 'complete' ? [...requiredSecrets, 'UNRELATED_NAME_CANARY'] : state === 'issuer-only' ? ['ACCESS_ISSUER'] : [])};
  console.log(JSON.stringify(names.map(name => ({ name, type: 'secret_text' }))));
} else process.exit(99);
`,
      );
      await chmod(resolve(directory, 'pnpm'), 0o755);
      const result = spawnSync(
        'bash',
        [
          '-e',
          '-c',
          `export CLOUDFLARE_ACCOUNT_ID=synthetic-account NOOK_HOSTNAME=synthetic.nook.test CLOUDFLARE_API_TOKEN=synthetic-fixture
export GITHUB_STEP_SUMMARY="$1"
${step.run}`,
          'installation-deploy-fixture',
          summary,
        ],
        {
          env: testEnvironment(resolve(directory, 'home'), {
            PATH: `${directory}${delimiter}${process.env.PATH}`,
          }),
          encoding: 'utf8',
          timeout: 10_000,
        },
      );
      expect(result.status, result.stderr).toBe(
        state === 'deploy-failed' ? 1 : 0,
      );
      const observed = JSON.parse(await readFile(calls, 'utf8')) as string[][];
      const secretCommands = observed.filter((args) => args[2] === 'secret');
      expect(secretCommands).toEqual(
        state === 'deploy-failed'
          ? []
          : [['exec', 'wrangler', 'secret', 'list', '--format', 'json']],
      );
      if (state !== 'deploy-failed')
        expect(
          observed.findIndex((args) => args[2] === 'secret'),
        ).toBeGreaterThan(observed.findIndex((args) => args[2] === 'deploy'));
      const text =
        summaryKind === 'file' ? await readFile(summary, 'utf8') : '';
      const output = `${text}\n${result.stdout}\n${result.stderr}`;
      expect(output.includes('UNRELATED_NAME_CANARY')).toBe(false);
      expect(output.includes('private-command-error-canary')).toBe(false);
      if (summaryKind === 'directory') return;
      if (state === 'complete' || state === 'deploy-failed') {
        expect(text).toBe('');
      } else if (state === 'list-failed') {
        expect(text).toMatch(/secret check could not run/i);
      } else {
        const missing = requiredSecrets.filter(
          (name) => state !== 'issuer-only' || name !== 'ACCESS_ISSUER',
        );
        for (const name of requiredSecrets)
          expect(text.includes(name), `Summary presence for ${name}`).toBe(
            missing.includes(name),
          );
        expect(text).toMatch(/docs\/install\.md#9-set-the-worker-secrets/);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
