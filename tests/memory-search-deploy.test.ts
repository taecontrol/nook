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

it('E23: deploy provisions both indexes only when missing and re-runs successfully before deployment', async () => {
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  expect(config.ai).toEqual({ binding: 'AI' });
  expect(config.vectorize).toEqual([
    { binding: 'MEMORY_INDEX', index_name: 'nook-memories' },
  ]);
  expect(config.triggers.crons).toEqual(['*/5 * * * *']);
  const workflow = parse(
    await readFile('.github/workflows/deploy.yml', 'utf8'),
  );
  const step = workflow.jobs.deploy.steps.find((s: { run?: string }) =>
    s.run?.includes('wrangler deploy'),
  );
  const directory = await mkdtemp(resolve('.local', 'search-deploy-'));
  const state = resolve(directory, 'state.json');
  const calls = resolve(directory, 'calls.json');
  try {
    await mkdir(resolve(directory, 'home'));
    await writeFile(
      resolve(directory, 'pnpm'),
      `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(${JSON.stringify(state)}, 'utf8'));
const calls = JSON.parse(readFileSync(${JSON.stringify(calls)}, 'utf8'));
calls.push(args); writeFileSync(${JSON.stringify(calls)}, JSON.stringify(calls));
const command = args.slice(2, 4).join(' ');
if (command === 'd1 list') console.log(JSON.stringify([{ name: 'nook' }]));
else if (command === 'vectorize list') console.log(JSON.stringify(state.index ? [{ name: 'nook-memories' }] : []));
else if (command === 'vectorize list-metadata-index') console.log(JSON.stringify(state.metadata ? [{ propertyName: 'bucket', indexType: 'String' }] : []));
else if (command === 'vectorize create') { if (state.index) process.exit(1); state.index = true; }
else if (command === 'vectorize create-metadata-index') { if (!state.index || state.metadata) process.exit(1); state.metadata = true; }
else if (args[2] === 'deploy' && (!state.index || !state.metadata)) process.exit(1);
writeFileSync(${JSON.stringify(state)}, JSON.stringify(state));
`,
    );
    await chmod(resolve(directory, 'pnpm'), 0o755);
    for (const initial of [
      { index: false, metadata: false },
      { index: true, metadata: false },
      { index: true, metadata: true },
    ]) {
      await writeFile(state, JSON.stringify(initial));
      await writeFile(calls, '[]');
      // Only the test-owned shell receives these literal synthetic values;
      // none of the owner's Cloudflare environment is inherited.
      const shell = `export CLOUDFLARE_ACCOUNT_ID=synthetic-account NOOK_HOSTNAME=synthetic.nook.test CLOUDFLARE_API_TOKEN=synthetic-fixture\n${step.run}`;
      const result = spawnSync('bash', ['-e', '-c', shell], {
        env: testEnvironment(resolve(directory, 'home'), {
          PATH: `${directory}${delimiter}${process.env.PATH}`,
        }),
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(
        result.status,
        'The real deployment shell runs against a deterministic command boundary',
      ).toBe(0);
      const observed = JSON.parse(await readFile(calls, 'utf8')) as string[][];
      expect(observed.filter((a) => a.includes('create'))).toHaveLength(
        initial.index ? 0 : 1,
      );
      expect(
        observed.filter((a) => a.includes('create-metadata-index')),
      ).toHaveLength(initial.metadata ? 0 : 1);
      expect(JSON.parse(await readFile(state, 'utf8'))).toEqual({
        index: true,
        metadata: true,
      });
      const deploy = observed.findIndex((a) => a[2] === 'deploy');
      expect(deploy).toBeGreaterThan(
        observed.findIndex((a) => a.includes('list-metadata-index')),
      );
      if (!initial.index)
        expect(observed.find((a) => a.includes('create'))).toEqual([
          'exec',
          'wrangler',
          'vectorize',
          'create',
          'nook-memories',
          '--dimensions',
          '1024',
          '--metric',
          'cosine',
        ]);
      if (!initial.metadata)
        expect(
          observed.find((a) => a.includes('create-metadata-index')),
        ).toEqual([
          'exec',
          'wrangler',
          'vectorize',
          'create-metadata-index',
          'nook-memories',
          '--property-name',
          'bucket',
          '--type',
          'string',
        ]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(['delayed', 'never'] as const)(
  'E23: deployment waits for metadata readiness or stops on %s readiness',
  async (readiness) => {
    const workflow = parse(
      await readFile('.github/workflows/deploy.yml', 'utf8'),
    );
    const step = workflow.jobs.deploy.steps.find((s: { run?: string }) =>
      s.run?.includes('wrangler deploy'),
    );
    const directory = await mkdtemp(resolve('.local', 'search-deploy-'));
    const state = resolve(directory, 'state.json');
    const calls = resolve(directory, 'calls.json');
    try {
      await mkdir(resolve(directory, 'home'));
      await writeFile(
        state,
        JSON.stringify({
          enqueued: false,
          metadata: false,
          remaining: readiness === 'delayed' ? 2 : 1000,
        }),
      );
      await writeFile(calls, '[]');
      await writeFile(
        resolve(directory, 'pnpm'),
        `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(${JSON.stringify(state)}, 'utf8'));
const calls = JSON.parse(readFileSync(${JSON.stringify(calls)}, 'utf8'));
calls.push(args); writeFileSync(${JSON.stringify(calls)}, JSON.stringify(calls));
const command = args.slice(2, 4).join(' ');
if (command === 'd1 list') console.log(JSON.stringify([{ name: 'nook' }]));
else if (command === 'vectorize list') console.log(JSON.stringify([{ name: 'nook-memories' }]));
else if (command === 'vectorize create-metadata-index') { if (state.enqueued) process.exit(1); state.enqueued = true; }
else if (command === 'vectorize list-metadata-index') {
  if (state.enqueued && state.remaining-- <= 0) state.metadata = true;
  console.log(JSON.stringify(state.metadata ? [{ propertyName: 'bucket', indexType: 'String' }] : []));
} else if (args[2] === 'deploy' && !state.metadata) process.exit(1);
writeFileSync(${JSON.stringify(state)}, JSON.stringify(state));
`,
      );
      await writeFile(
        resolve(directory, 'sleep'),
        `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const calls = JSON.parse(readFileSync(${JSON.stringify(calls)}, 'utf8'));
calls.push(['sleep', ...process.argv.slice(2)]);
writeFileSync(${JSON.stringify(calls)}, JSON.stringify(calls));
`,
      );
      await chmod(resolve(directory, 'pnpm'), 0o755);
      await chmod(resolve(directory, 'sleep'), 0o755);
      const result = spawnSync(
        'bash',
        [
          '-e',
          '-c',
          `export CLOUDFLARE_ACCOUNT_ID=synthetic-account NOOK_HOSTNAME=synthetic.nook.test CLOUDFLARE_API_TOKEN=synthetic-fixture\n${step.run}`,
        ],
        {
          env: testEnvironment(resolve(directory, 'home'), {
            PATH: `${directory}${delimiter}${process.env.PATH}`,
          }),
          encoding: 'utf8',
          timeout: 10_000,
        },
      );
      const observed = JSON.parse(await readFile(calls, 'utf8')) as string[][];
      expect(
        observed.filter((a) => a.includes('create-metadata-index')),
      ).toHaveLength(1);
      const deploy = observed.findIndex((a) => a[2] === 'deploy');
      if (readiness === 'delayed') {
        expect(result.status).toBe(0);
        expect(JSON.parse(await readFile(state, 'utf8')).metadata).toBe(true);
        expect(deploy).toBeGreaterThan(
          observed.findLastIndex((a) => a.includes('list-metadata-index')),
        );
        expect(observed.filter((a) => a[0] === 'sleep')).toHaveLength(2);
      } else {
        expect(result.status).toBe(1);
        expect(deploy).toBe(-1);
        expect(result.stderr).toContain('Metadata index did not become ready.');
        expect(
          observed.filter((a) => a.includes('list-metadata-index')),
        ).toHaveLength(21);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
