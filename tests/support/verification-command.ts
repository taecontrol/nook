import { spawnSync } from 'node:child_process';
import {
  appendFile,
  cp,
  mkdir,
  readdir,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fingerprintDirectory } from '../../scripts/lib/host-resources.ts';
import { testEnvironment } from '../../scripts/lib/test-environment.ts';

export async function refusedVerification(
  home: string,
  entrypoint: string,
  args: string[],
) {
  const workspace = resolve(home, 'workspace');
  const evidence = resolve(workspace, '.local/verification/coverage');
  await mkdir(evidence, { recursive: true });
  await writeFile(
    resolve(evidence, 'baseline.json'),
    '{"synthetic":"baseline"}',
  );
  await writeFile(
    resolve(evidence, 'node-existing.json'),
    '{"synthetic":"execution"}',
  );
  const before = await fingerprintDirectory(workspace);
  const observations = resolve(home, 'observations');
  await writeFile(observations, '');
  const preload = resolve(home, 'observe.mjs');
  // Keep the real platform and entrypoint. Observe and block side effects even
  // before the refusal exists, redirecting owner discovery to synthetic HOME.
  await writeFile(
    preload,
    `
import children from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
const record = event => appendFileSync(${JSON.stringify(observations)}, event + '\\n');
os.userInfo = () => {
  record('owner-resources');
  return { homedir: ${JSON.stringify(home)}, uid: 12345, gid: 12345, username: 'synthetic-owner', shell: '/bin/sh' };
};
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  children[name] = () => {
    record('child:' + name);
    throw new Error('Verification attempted a forbidden child process.');
  };
}
syncBuiltinESMExports();
`,
  );
  const result = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(preload).href, resolve(entrypoint), ...args],
    {
      cwd: workspace,
      env: testEnvironment(home, { COVERAGE_RUN: undefined }),
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  return {
    result,
    observations: await readFile(observations, 'utf8'),
    before,
    after: await fingerprintDirectory(workspace),
    evidence: await Promise.all(
      ['baseline.json', 'node-existing.json'].map((name) =>
        readFile(resolve(evidence, name), 'utf8').catch(() => '<missing>'),
      ),
    ),
  };
}

export async function verificationWorkspace(home: string) {
  const workspace = resolve(home, 'workspace');
  await mkdir(workspace);
  const modules = new Set<string>();
  const roots = ['apps', 'packages', 'scripts', 'tests', 'docs'];
  const configuration = (await readdir('.')).filter((name) =>
    /\.(?:ts|json)$/.test(name),
  );
  for (const path of [
    ...roots,
    ...configuration,
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'wrangler.jsonc',
  ])
    await cp(resolve(path), resolve(workspace, path), {
      recursive: true,
      filter: (path) => {
        const name = basename(path);
        if (name === 'node_modules') {
          modules.add(path);
          return false;
        }
        return (
          !['.local', '.wrangler', 'dist'].includes(name) &&
          !name.startsWith('.env')
        );
      },
    });
  modules.add(resolve('node_modules'));
  for (const path of modules)
    await symlink(path, resolve(workspace, relative(process.cwd(), path)));
  // The disposable copy reuses installed dependencies. Prevent pnpm from
  // reinstalling through these links; the real workspace keeps its checks.
  await appendFile(
    resolve(workspace, 'pnpm-workspace.yaml'),
    '\nverifyDepsBeforeRun: false\n',
  );
  return workspace;
}
