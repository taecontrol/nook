import { spawn, spawnSync } from 'node:child_process';
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import {
  temporaryTestHome,
  testEnvironment,
} from '../../scripts/lib/test-environment.ts';

type Lifecycle = 'onClose' | 'ambiguousClose' | 'buildProduct' | 'buildTest';
type Identity = {
  pid: number;
  group: number;
  uid: number;
  started: string;
};

// Cleanup uses its own kernel reader and records, outside the candidate registry.
function processes(): Identity[] {
  const observed = spawnSync(
    '/bin/ps',
    ['-axo', 'pid=,ppid=,pgid=,uid=,lstart=,comm='],
    {
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  if (observed.error || observed.status !== 0)
    throw new Error('Lifecycle keeper could not inspect kernel identities.');
  return observed.stdout.split('\n').flatMap((line) => {
    const fields =
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+.+$/.exec(
        line,
      );
    return fields
      ? [
          {
            pid: Number(fields[1]),
            group: Number(fields[3]),
            uid: Number(fields[4]),
            started: fields[5],
          },
        ]
      : [];
  });
}

function sameIdentity(before: Identity, after: Identity | undefined) {
  return (
    after?.pid === before.pid &&
    after.started === before.started &&
    after.uid === before.uid &&
    after.group === before.group
  );
}

export function readMacFixtureProcess(pid: number | undefined) {
  if (!pid) return;
  return processes().find((item) => item.pid === pid);
}

export function macFixtureProcessAlive(identity: Identity | undefined) {
  return (
    !!identity && sameIdentity(identity, readMacFixtureProcess(identity.pid))
  );
}

function stop(identity: Identity | undefined) {
  if (!identity || identity.uid !== userInfo().uid) return;
  const current = processes().find((item) => item.pid === identity.pid);
  if (!sameIdentity(identity, current)) return;
  try {
    process.kill(identity.pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

export async function closeMacFixtureProcess(identity: Identity | undefined) {
  stop(identity);
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!macFixtureProcessAlive(identity)) return;
    await new Promise((accept) => setTimeout(accept, 50));
  }
  throw new Error('Independent cleanup left its known fixture process alive.');
}

function validIdentity(identity: Identity) {
  return (
    [identity.pid, identity.group].every(
      (id) => Number.isSafeInteger(id) && id > 0,
    ) &&
    identity.uid === userInfo().uid &&
    typeof identity.started === 'string' &&
    !!identity.started.trim()
  );
}

async function records(directory: string): Promise<Identity[]> {
  const observed = await Promise.all(
    (await readdir(directory)).map(async (name) => {
      if (!/^\d+-\d+\.json$/.test(name))
        throw new Error('Lifecycle keeper found an invalid identity record.');
      const identity: Identity = JSON.parse(
        await readFile(resolve(directory, name), 'utf8'),
      );
      if (!validIdentity(identity))
        throw new Error('Lifecycle keeper found an invalid kernel identity.');
      return identity;
    }),
  );
  return [
    ...new Map(
      observed.map((item) => [
        `${item.pid}:${item.started}:${item.uid}:${item.group}`,
        item,
      ]),
    ).values(),
  ];
}

async function reclaim(directory: string) {
  const known = await records(directory);
  for (const identity of known) stop(identity);
  for (let attempt = 0; attempt < 40; attempt++) {
    const current = processes();
    if (
      known.every(
        (identity) =>
          !sameIdentity(
            identity,
            current.find((item) => item.pid === identity.pid),
          ),
      )
    )
      return;
    await new Promise((accept) => setTimeout(accept, 50));
  }
  throw new Error('Lifecycle keeper left a known fixture process alive.');
}

function independentPreload(directory: string, preload: string) {
  return `
import children from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { userInfo } from 'node:os';
const spawn = children.spawn;
const fork = children.fork;
const inspect = children.spawnSync;
const directory = ${JSON.stringify(directory)};
const flag = ${JSON.stringify(`--import=${pathToFileURL(preload).href}`)};
function settings(value) {
  const env = { ...(value?.env ?? process.env) };
  if (!(env.NODE_OPTIONS ?? '').includes(flag))
    env.NODE_OPTIONS = flag + ' ' + (env.NODE_OPTIONS ?? '');
  return { ...value, env };
}
function record(pid) {
  if (!pid) return;
  const observed = inspect('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,uid=,lstart=,comm='],
    { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, encoding: 'utf8', timeout: 5000 });
  if (observed.error || observed.status !== 0)
    throw new Error('Independent lifecycle registration failed.');
  const fields = observed.stdout.split('\\n').map((line) =>
    /^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\w{3}\\s+\\w{3}\\s+\\d+\\s+\\d{2}:\\d{2}:\\d{2}\\s+\\d{4})\\s+.+$/.exec(line))
    .find((item) => item && Number(item[1]) === pid);
  if (!fields) return;
  if (Number(fields[4]) !== userInfo().uid)
    throw new Error('Independent lifecycle registration found a foreign UID.');
  writeFileSync(directory + '/' + process.pid + '-' + pid + '.json', JSON.stringify({
    pid, group: Number(fields[3]), uid: Number(fields[4]), started: fields[5],
  }), { mode: 0o600 });
}
record(process.pid);
children.spawn = (file, parameters, options) => {
  const args = Array.isArray(parameters) ? parameters : [];
  const value = Array.isArray(parameters) ? options : parameters;
  const child = spawn(file, args, settings(value)); record(child.pid); return child;
};
children.fork = (file, parameters, options) => {
  const args = Array.isArray(parameters) ? parameters : [];
  const value = Array.isArray(parameters) ? options : parameters;
  const child = fork(file, args, settings(value)); record(child.pid); return child;
};
syncBuiltinESMExports();
`;
}

async function buildWorkspace(home: string) {
  const workspace = resolve(home, 'build-source');
  await mkdir(workspace);
  const workspaceModules = new Set<string>();
  const excluded = new Set([
    '.git',
    '.work',
    '.local',
    '.wrangler',
    '.e2e',
    'dist',
  ]);
  for (const file of [
    'apps',
    'packages',
    'scripts',
    'docs',
    'coverage.config.json',
    'vite.config.ts',
    'tsconfig.json',
    'package.json',
  ])
    await cp(resolve(file), resolve(workspace, file), {
      recursive: true,
      filter: (path) => {
        if (basename(path) === 'node_modules') {
          workspaceModules.add(path);
          return false;
        }
        return (
          !excluded.has(basename(path)) &&
          !/^\.env(?:\.|$)/.test(basename(path))
        );
      },
    });
  await symlink(resolve('node_modules'), resolve(workspace, 'node_modules'));
  for (const modules of workspaceModules)
    await symlink(
      modules,
      resolve(workspace, relative(process.cwd(), modules)),
    );
  return workspace;
}

async function recordDiagnostic(mode: Lifecycle, home: string, output: string) {
  const directory = resolve('.local/verification/screenshots');
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, `lifecycle-${mode}.log`),
    stripVTControlCharacters(output)
      .replace(/nook_[A-Za-z0-9_-]*/g, '<synthetic-token>')
      .replace(/(Bearer\s+)[^\s"\\]+/gi, '$1<synthetic-token>')
      .replaceAll(home, '<lifecycle-home>')
      .replaceAll(process.cwd(), '<checkout>'),
  );
}

async function runner(directory: string, mode: Lifecycle, home: string) {
  const moduleUrl = (file: string) => pathToFileURL(resolve(file)).href;
  if (mode === 'buildProduct' || mode === 'buildTest') {
    const workspace = await buildWorkspace(home);
    const buildUrl = (file: string) =>
      pathToFileURL(resolve(workspace, file)).href;
    const file = resolve(directory, 'build.mjs');
    const target = mode === 'buildProduct' ? 'build.ts' : 'test-build.ts';
    await writeFile(
      file,
      `
import { startHostIsolation } from ${JSON.stringify(buildUrl('scripts/lib/host-isolation.ts'))};
import { trackMacFixtureProcesses } from ${JSON.stringify(buildUrl('scripts/lib/macos-process-groups.ts'))};
import { ${mode} } from ${JSON.stringify(buildUrl(`scripts/${target}`))};
const isolation = await startHostIsolation();
trackMacFixtureProcesses();
try { await ${mode}(${mode === 'buildProduct' ? JSON.stringify(resolve(home, 'product')) : ''}); }
finally { await isolation.close(); }
`,
    );
    return { args: [file], cwd: workspace };
  }
  await writeFile(
    resolve(directory, 'keeper.test.ts'),
    `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { expect, it } from ${JSON.stringify(moduleUrl('node_modules/vitest/dist/index.js'))};
import { recordMacProcessGroup } from ${JSON.stringify(moduleUrl('scripts/lib/macos-process-groups.ts'))};
it('E19: a passing worker deliberately leaves one known fixture child', () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
    { env: process.env, detached: true, stdio: 'ignore' });
  expect(Number.isSafeInteger(child.pid) && child.pid > 0).toBe(true);
  const identity = recordMacProcessGroup(child.pid);
  expect(identity).toBeDefined();
  ${mode === 'ambiguousClose' ? "writeFileSync(process.env.NOOK_TEST_PROCESS_GROUPS + '/' + child.pid + '.json', JSON.stringify({ ...identity, started: 'stale-recorded-birth' }));" : ''}
  child.unref();
  console.log('E19_KNOWN_PID=' + child.pid);
});
`,
  );
  const config = resolve(directory, 'vitest.config.mjs');
  await writeFile(
    config,
    `export default ${JSON.stringify({
      root: process.cwd(),
      server: { fs: { allow: [process.cwd(), home] } },
      test: {
        dir: directory,
        include: ['keeper.test.ts'],
        globalSetup: [resolve('scripts/lib/host-isolation.ts')],
        setupFiles: [resolve('tests/coverage-setup.ts')],
        maxWorkers: 1,
        testTimeout: 10_000,
        hookTimeout: 20_000,
      },
    })};`,
  );
  return {
    args: [
      resolve('node_modules/vitest/vitest.mjs'),
      'run',
      '--config',
      config,
      '--reporter=verbose',
    ],
    cwd: process.cwd(),
  };
}

async function execute(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const identity = processes().find((item) => item.pid === child.pid);
  let output = '';
  let overflow = false;
  let timedOut = false;
  let terminationError: unknown;
  let finish: ((status: number | null) => void) | undefined;
  const terminate = () => {
    try {
      stop(identity);
    } catch (error) {
      terminationError = error;
    }
  };
  const capture = (chunk: Buffer) => {
    if (output.length + chunk.length > 2 * 1024 * 1024) {
      overflow = true;
      terminate();
      finish?.(null);
    } else output += chunk;
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
    finish?.(null);
  }, 45_000);
  try {
    const status = await new Promise<number | null>((accept, reject) => {
      finish = accept;
      child.once('error', reject);
      child.once('exit', accept);
    });
    await new Promise((accept) => setTimeout(accept, 50));
    if (overflow || timedOut || terminationError)
      throw new Error('Lifecycle keeper exceeded its bounded run.');
    return { status, output };
  } finally {
    clearTimeout(timeout);
    terminate();
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

export async function runMacHostLifecycle(mode: Lifecycle) {
  if (process.platform !== 'darwin')
    throw new Error('The lifecycle keeper requires macOS kernel metadata.');
  const home = await temporaryTestHome();
  const directory = resolve(home, 'lifecycle');
  const registry = resolve(directory, 'independent-identities');
  await mkdir(registry, { recursive: true, mode: 0o700 });
  try {
    const preload = resolve(directory, 'independent-preload.mjs');
    await writeFile(preload, independentPreload(registry, preload));
    const command = await runner(directory, mode, home);
    const result = await execute(
      command.args,
      command.cwd,
      testEnvironment(home, {
        COVERAGE_RUN: undefined,
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      }),
    );
    await recordDiagnostic(mode, home, result.output);
    const known = await records(registry);
    const current = processes();
    const remaining = known.filter((item) =>
      sameIdentity(
        item,
        current.find((process) => process.pid === item.pid),
      ),
    );
    const pid = Number(/E19_KNOWN_PID=(\d+)/.exec(result.output)?.[1]);
    return {
      ...result,
      knownChild: known.find((item) => item.pid === pid),
      childAlive: remaining.some((item) => item.pid === pid),
      remaining: remaining.length,
    };
  } finally {
    await reclaim(registry);
    await rm(home, { recursive: true, force: true });
  }
}
