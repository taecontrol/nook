import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname } from 'node:path';
import { evidenceRoot } from '../../scripts/lib/instrument.ts';

export function launchSandbox(
  home: string,
  env: NodeJS.ProcessEnv,
  executable: string,
  args: string[],
  bubblewrap = 'bwrap',
) {
  const owner = userInfo();
  const node = dirname(dirname(realpathSync(process.execPath)));
  const repository = process.cwd();
  const mounts = [
    '--ro-bind',
    '/usr',
    '/usr',
    '--symlink',
    'usr/bin',
    '/bin',
    '--symlink',
    'usr/lib',
    '/lib',
    '--symlink',
    'usr/lib64',
    '/lib64',
    '--symlink',
    'usr/sbin',
    '/sbin',
    '--ro-bind',
    '/etc',
    '/etc',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--tmpfs',
    '/home',
    '--tmpfs',
    '/run',
    '--dir',
    owner.homedir,
    '--dir',
    `/run/user/${owner.uid}`,
    '--ro-bind',
    node,
    node,
    '--ro-bind',
    repository,
    repository,
    // Bind after the repository: a fixture beneath it must stay writable.
    '--bind',
    home,
    home,
    ...(env.COVERAGE_RUN ? ['--bind', evidenceRoot, evidenceRoot] : []),
  ];
  const environment = Object.entries(env).flatMap(([name, value]) =>
    value === undefined ? [] : ['--setenv', name, value],
  );
  const child = spawn(
    bubblewrap,
    [
      '--unshare-user',
      '--unshare-pid',
      '--unshare-ipc',
      '--die-with-parent',
      '--new-session',
      ...mounts,
      '--chdir',
      repository,
      '--clearenv',
      ...environment,
      '--',
      // bwrap adds PWD after --clearenv; remove it before executing the child.
      '/usr/bin/env',
      '--unset=PWD',
      executable,
      ...args,
    ],
    { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let message: string | undefined;
  let diagnostic = '';
  child.stderr.on('data', (chunk) => {
    // Classify only known setup failures. Never forward daemon diagnostics,
    // command arguments, or secret-tool output to the test runner.
    diagnostic = (diagnostic + String(chunk)).slice(-512);
    if (diagnostic.includes('setting up uid map: Permission denied'))
      message =
        "Bubblewrap user namespace denied. Load the repository's nook-bwrap AppArmor profile with sudo apparmor_parser -r .github/apparmor/nook-bwrap.";
    else if (diagnostic.includes('No such file or directory'))
      message ??= 'Sandbox command unavailable (ENOENT).';
  });
  child.on('error', (error: NodeJS.ErrnoException) => {
    message =
      error.code === 'ENOENT'
        ? 'Bubblewrap is required for host-resource tests. Install bubblewrap.'
        : 'Bubblewrap could not start the sandbox.';
  });
  // A failed spawn emits close too. Teardown must always have a completion.
  const closed = new Promise<number | null>((accept) =>
    child.once('close', accept),
  );
  function killGroup() {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* Already stopped. */
    }
  }
  async function stop() {
    child.stdin.end();
    const timeout = setTimeout(killGroup, 2000);
    try {
      await closed;
    } finally {
      clearTimeout(timeout);
      killGroup();
    }
  }
  let stopping: Promise<void> | undefined;
  return {
    child,
    closed,
    failure: (fallback: string) => new Error(message ?? fallback),
    close: () => (stopping ??= stop()),
  };
}
