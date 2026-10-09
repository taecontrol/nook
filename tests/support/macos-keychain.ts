import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { snapshotProcesses } from '../../scripts/lib/host-processes.ts';
import { evidenceRoot } from '../../scripts/lib/instrument.ts';
import { spawnMacFixtureProcess } from '../../scripts/lib/macos-process-groups.ts';
import { testEnvironment } from '../../scripts/lib/test-environment.ts';
import { stopMacFixtureGroups } from './macos-command-cleanup.ts';
import { testBuild } from './runtime.ts';

export type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals;
};

async function observeSecurity(args: string[], env: NodeJS.ProcessEnv) {
  const command = startCommand('/usr/bin/security', args, env);
  const timeout = setTimeout(() => command.kill('SIGKILL'), 5000);
  try {
    return await command.done;
  } finally {
    clearTimeout(timeout);
  }
}

export async function requireFreshKeychainHome(
  home: string,
  env: NodeJS.ProcessEnv,
  observe = (args: string[]) => observeSecurity(args, env),
) {
  const root = await realpath(home);
  if (
    home !== root ||
    env.HOME !== root ||
    root === (await realpath(userInfo().homedir))
  )
    throw new Error(
      'Keychain creation requires a fresh resolved temporary HOME.',
    );
  const search = await observe(['list-keychains', '-d', 'user']);
  const login = await observe(['login-keychain']);
  if (
    search.status !== 0 ||
    search.stdout.trim() ||
    login.status !== 1 ||
    login.stdout.trim() ||
    !login.stderr.includes('The specified keychain could not be found.')
  )
    throw new Error(
      'Keychain creation requires an empty search list and no login keychain. No write was attempted.',
    );
}

function startCommand(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input = '',
  mirror?: string,
  workingDirectory = process.cwd(),
) {
  const child = spawnMacFixtureProcess(
    () =>
      spawn(file, args, {
        env,
        cwd: workingDirectory,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    mirror,
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdin.on('error', () => {});
  const done = new Promise<CommandResult>((accept) => {
    child.on('error', () =>
      accept({ status: 1, stdout: '', stderr: 'Fixture command unavailable.' }),
    );
    child.on('close', (status, signal) =>
      accept({
        status: status ?? 1,
        stdout,
        stderr,
        ...(signal ? { signal } : {}),
      }),
    );
  });
  child.stdin.end(input);
  return {
    child,
    done,
    output: () => stdout + stderr,
    kill: (signal: NodeJS.Signals = 'SIGTERM') => child.kill(signal),
  };
}

// After creation, this gate must pass before any item command or CLI child.
export async function requireFixtureKeychain(
  home: string,
  env: NodeJS.ProcessEnv,
  observe = (args: string[]) => observeSecurity(args, env),
) {
  const root = await realpath(home);
  if (env.HOME !== home)
    throw new Error(
      'Keychain fixture HOME is misdirected. No write was attempted.',
    );
  for (const args of [['login-keychain'], ['default-keychain', '-d', 'user']]) {
    const result = await observe(args);
    const path = /^\s*"([^"]+)"\s*$/.exec(result.stdout)?.[1];
    if (result.status !== 0 || !path)
      throw new Error('Keychain fixture gate failed. No write was attempted.');
    // security resolves /tmp to /private/tmp, including for nonexistent keychains.
    const parent = await realpath(resolve(path, '..')).catch(() => '');
    if (!parent.startsWith(`${root}${sep}`))
      throw new Error(
        'Keychain fixture escaped temporary HOME. No write was attempted.',
      );
  }
}

export const securityShim =
  '#!/bin/sh\nprintf "%s\\n" "$@" >> "$HOME/argv"\nexec /usr/bin/security "$@"\n';

export async function privateMacKeychain(
  options: {
    tempRoot?: string;
    observeGate?: (args: string[]) => Promise<CommandResult>;
  } = {},
) {
  if (process.platform !== 'darwin')
    throw new Error('The macOS fixture requires macOS.');
  if (process.env.NOOK_TEST_MACOS_KEYCHAIN_BOOTSTRAP !== 'github-hosted')
    throw new Error(
      'macOS CLI acceptance requires explicit disposable GitHub-hosted runner opt-in. Local Keychain creation is forbidden. See https://github.com/taecontrol/nook/issues/40.',
    );
  const home = await realpath(
    await mkdtemp(resolve(options.tempRoot ?? '/tmp', 'nook-cli-')),
  );
  const shim = resolve(home, 'bin');
  const keychain = resolve(home, 'Library/Keychains/login.keychain-db');
  const groups = resolve(home, 'fixture-process-groups');
  const baseline = await snapshotProcesses();
  const children = new Set<ReturnType<typeof startCommand>>();
  let closed = false;
  let journalReady = false;
  async function close() {
    if (closed) return;
    if (journalReady) await stopMacFixtureGroups(baseline, groups);
    await Promise.all([...children].map((command) => command.done));
    children.clear();
    await rm(home, { recursive: true, force: true });
    closed = true;
  }
  try {
    for (const directory of [
      'bin',
      'config',
      'data',
      'state',
      'cache',
      'runtime',
      'Library/Keychains',
      'fixture-process-groups',
    ])
      await mkdir(resolve(home, directory), { recursive: true, mode: 0o700 });
    journalReady = true;
    await writeFile(resolve(shim, 'security'), securityShim, { mode: 0o700 });
    await writeFile(
      resolve(shim, 'open'),
      '#!/bin/sh\nprintf "%s\\n" "$@" >> "$HOME/opened"\nexit "${NOOK_TEST_OPEN_STATUS:-0}"\n',
      { mode: 0o700 },
    );
    const groupHook = resolve(home, 'process-groups.mjs');
    await writeFile(
      groupHook,
      `
import { trackMacFixtureProcesses } from ${JSON.stringify(pathToFileURL(resolve('scripts/lib/macos-process-groups.ts')).href)};
trackMacFixtureProcesses(${JSON.stringify(groups)});
`,
      { mode: 0o600 },
    );
    const env = testEnvironment(home, { PATH: `${shim}:/usr/bin:/bin` });
    await requireFreshKeychainHome(home, env);
    const creating = startCommand(
      '/usr/bin/security',
      ['create-keychain', '-p', 'synthetic-keychain-password', keychain],
      env,
      '',
      groups,
    );
    children.add(creating);
    const timeout = setTimeout(() => creating.kill('SIGKILL'), 5000);
    let created: CommandResult;
    try {
      created = await creating.done;
    } finally {
      clearTimeout(timeout);
      children.delete(creating);
    }
    if (created.status !== 0 || !existsSync(keychain))
      throw new Error('Temporary login keychain could not be created.');
    await requireFixtureKeychain(home, env, options.observeGate);
    function command(
      file: string,
      args: string[],
      extra: NodeJS.ProcessEnv = {},
      input = '',
      workingDirectory = process.cwd(),
    ) {
      if (!existsSync(keychain))
        throw new Error(
          'The fixture keychain must exist before every command.',
        );
      const childEnv = testEnvironment(home, {
        PATH: `${shim}:/usr/bin:/bin`,
        ...extra,
      });
      if (childEnv.PATH?.split(':')[0] !== shim)
        throw new Error('Fixture shims must be first on PATH.');
      const running = startCommand(
        file,
        args,
        childEnv,
        input,
        groups,
        workingDirectory,
      );
      children.add(running);
      void running.done.then(() => children.delete(running));
      return running;
    }
    return {
      home,
      shim,
      keychain,
      config: resolve(home, 'config/nook/config.json'),
      close,
      command,
      start(
        args: string[],
        extra: NodeJS.ProcessEnv = {},
        input = '',
        workingDirectory = home,
      ) {
        if (!existsSync(resolve(testBuild, 'cli.js')))
          throw new Error('The built CLI is required.');
        return command(
          process.execPath,
          [resolve(testBuild, 'cli.js'), ...args],
          {
            NODE_OPTIONS: `--import=${pathToFileURL(groupHook).href}`,
            ...(process.env.COVERAGE_RUN
              ? {
                  NOOK_CLI_COVERAGE: resolve(
                    evidenceRoot,
                    `cli-${crypto.randomUUID()}.json`,
                  ),
                }
              : {}),
            ...extra,
          },
          input,
          workingDirectory,
        );
      },
      async lookup(url: string) {
        const result = await command('/usr/bin/security', [
          'find-generic-password',
          '-s',
          'nook',
          '-a',
          url,
          '-w',
        ]).done;
        if (![0, 44].includes(result.status))
          throw new Error('Fixture lookup failed.');
        return result.stdout.trim();
      },
      async inspect(url: string) {
        return command('/usr/bin/security', [
          'find-generic-password',
          '-s',
          'nook',
          '-a',
          url,
        ]).done;
      },
      async inspectService(service: string) {
        return command('/usr/bin/security', [
          'find-generic-password',
          '-s',
          service,
        ]).done;
      },
      async store(url: string, token: string) {
        const quote = (value: string) =>
          `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
        return (
          await command(
            '/usr/bin/security',
            ['-i'],
            {},
            `add-generic-password -s "nook" -a ${quote(url)} -l ${quote('Nook machine "synthetic"')} -w ${quote(token)}\n`,
          ).done
        ).status;
      },
      bus: '',
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export type PrivateMacKeychain = Awaited<ReturnType<typeof privateMacKeychain>>;
