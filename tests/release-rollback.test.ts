import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { parse } from 'yaml';
import { testEnvironment } from '../scripts/lib/test-environment.ts';

// Runs the release workflow's own tag and rollback scripts against a local
// bare repository standing in for GitHub, with gh and ssh replaced by stubs.
const release = parse(await readFile('.github/workflows/release.yml', 'utf8'));
const deployKey = 'fixture-deploy-key-value';
const tag = 'refs/tags/v0.1.0';

let directory: string;
let remote: string;
let log: string;
let commit: string;
let env: NodeJS.ProcessEnv;

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function remoteTags() {
  return git(directory, 'ls-remote', '--tags', remote);
}

async function runStep(job: string, name: string, fail = '') {
  const steps: { name?: string; uses?: string; run?: string }[] =
    release.jobs[job].steps;
  const index = steps.findIndex((step) => step.name === name);
  expect(index).toBeGreaterThanOrEqual(0);
  // A job without actions/checkout runs in an empty workspace, as on GitHub.
  const workspace = await mkdtemp(resolve(directory, `${job}-`));
  if (
    steps
      .slice(0, index)
      .some((step) => step.uses?.startsWith('actions/checkout@'))
  )
    git(workspace, 'clone', '-q', remote, '.');
  return spawnSync(
    'bash',
    ['--noprofile', '--norc', '-eo', 'pipefail', '-c', steps[index].run ?? ''],
    {
      cwd: workspace,
      env: { ...env, RELEASE_FAIL: fail },
      encoding: 'utf8',
      timeout: 20_000,
    },
  );
}

beforeEach(async () => {
  // Outside the repository, so git cannot fall back to the project's .git.
  directory = await mkdtemp(resolve(tmpdir(), 'nook-release-rollback-'));
  const bin = resolve(directory, 'bin');
  const remotes = resolve(directory, 'remotes');
  remote = resolve(remotes, 'synthetic/nook.git');
  log = resolve(directory, 'calls.log');
  await mkdir(bin);
  await mkdir(remote, { recursive: true });
  await writeFile(log, '');
  await writeFile(
    resolve(bin, 'gh'),
    `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$RELEASE_LOG"
case "$1 $2" in
  'api meta') echo 'ssh-ed25519 AAAAfixture' ;;
  "release $RELEASE_FAIL") exit 1 ;;
esac
`,
  );
  await writeFile(
    resolve(bin, 'ssh'),
    `#!/bin/sh
printf 'ssh %s\\n' "$*" >> "$RELEASE_LOG"
for command; do :; done
cd "$RELEASE_REMOTES" && exec sh -c "git \${command#git-}"
`,
  );
  await chmod(resolve(bin, 'gh'), 0o755);
  await chmod(resolve(bin, 'ssh'), 0o755);
  env = testEnvironment(resolve(directory, 'home'), {
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    GITHUB_REPOSITORY: 'synthetic/nook',
    VERSION: '0.1.0',
    RELEASE_TAG_DEPLOY_KEY: deployKey,
    RELEASE_LOG: log,
    RELEASE_REMOTES: remotes,
  });
  git(remote, 'init', '-q', '--bare');
  const source = resolve(directory, 'source');
  await mkdir(source);
  git(source, 'init', '-q');
  git(
    source,
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.com',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'fixture',
  );
  git(source, 'push', '-q', remote, 'HEAD:refs/heads/main');
  commit = git(source, 'rev-parse', 'HEAD');
  env.GITHUB_SHA = commit;
});

afterEach(async () => {
  expect(await readFile(log, 'utf8')).not.toContain(deployKey);
  await rm(directory, { recursive: true, force: true });
});

it('publish pushes the tag for the dispatched commit and publishes the draft release', async () => {
  const result = await runStep(
    'publish',
    'Tag and publish, deleting both if either fails',
  );
  expect(result.status, result.stderr).toBe(0);
  expect(remoteTags()).toBe(`${commit}\t${tag}`);
  const calls = await readFile(log, 'utf8');
  expect(calls).toContain('gh release create v0.1.0 release-assets/* --draft');
  expect(calls).toContain('gh release edit v0.1.0 --draft=false');
  expect(calls).not.toContain('gh release delete');
});

it.each([
  ['the release cannot be created', 'create', false],
  ['the draft release cannot be published', 'edit', true],
])(
  'publish deletes the tag when %s, and the release it created',
  async (_, fail, created) => {
    const result = await runStep(
      'publish',
      'Tag and publish, deleting both if either fails',
      fail,
    );
    expect(result.status).not.toBe(0);
    expect(remoteTags()).toBe('');
    expect(
      (await readFile(log, 'utf8')).includes('gh release delete v0.1.0 --yes'),
    ).toBe(created);
  },
);

it('unpublish deletes the published release and its tag after a failed mise smoke test', async () => {
  expect(
    (await runStep('publish', 'Tag and publish, deleting both if either fails'))
      .status,
  ).toBe(0);
  const result = await runStep('unpublish', 'Delete the release and its tag');
  expect(result.status, result.stderr).toBe(0);
  expect(remoteTags()).toBe('');
  expect(await readFile(log, 'utf8')).toContain(
    'gh release delete v0.1.0 --repo synthetic/nook --yes',
  );
});
