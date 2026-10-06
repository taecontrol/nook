import children, {
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import type { HostProcess } from './host-processes.ts';
import { macProcessesSync } from './macos-processes.ts';

export type MacProcessGroup = {
  pid: number;
  started: string;
  group: number;
  root: number;
  uid: number;
};

let tracking = false;

// Test workers and the CLI preload use the same spawn boundary for fixture hosts.
export function trackMacFixtureProcesses(mirror?: string) {
  if (process.platform !== 'darwin' || tracking) return;
  const spawn = children.spawn;
  children.spawn = ((
    file: string,
    parameters?: readonly string[] | SpawnOptions,
    options?: SpawnOptions,
  ) => {
    const args = Array.isArray(parameters) ? parameters : [];
    const settings = Array.isArray(parameters)
      ? options
      : (parameters as SpawnOptions | undefined);
    return spawnMacFixtureProcess(
      () => spawn(file, args, { ...settings, detached: true }),
      mirror,
    );
  }) as typeof children.spawn;
  syncBuiltinESMExports();
  tracking = true;
}

export function requireMacProcessRegistry() {
  const directory = process.env.NOOK_TEST_PROCESS_GROUPS;
  const root = Number(process.env.NOOK_TEST_ROOT_PID);
  if (!directory || !Number.isSafeInteger(root) || root <= 0)
    throw new Error(
      'macOS fixture commands require the isolated process-group registry.',
    );
  return { directory, root };
}

function spawnedProcess(pid: number, inspect: () => HostProcess[]) {
  const observed = inspect();
  const current = observed.find((item) => item.pid === pid);
  if (current) {
    if (current.parent !== process.pid || current.group !== pid)
      throw new Error('macOS fixture command has an unverified launcher.');
    return current;
  }
  if (observed.some((item) => item.group === pid))
    throw new Error('macOS fixture command exited with an unverified group.');
  // A completed snapshot with no leader or member proves this group is gone.
  return undefined;
}

// Mark uncertainty before launch: even SIGKILL cannot erase an unfinished spawn.
export function spawnMacFixtureProcess<T extends ChildProcess>(
  launch: () => T,
  mirror?: string,
  inspect = macProcessesSync,
): T {
  const { directory } = requireMacProcessRegistry();
  const pending = resolve(
    mirror ?? directory,
    `pending-${crypto.randomUUID()}`,
  );
  try {
    writeFileSync(pending, '', { mode: 0o600 });
    const child = launch();
    if (child.pid)
      recordMacProcessGroup(
        child.pid,
        (pid) => spawnedProcess(pid, inspect),
        mirror,
      );
    unlinkSync(pending);
    return child;
  } catch {
    throw new Error(
      'macOS fixture command could not register its process group.',
    );
  }
}

function kernelIdentity(pid: number, process: HostProcess) {
  if (
    process.pid !== pid ||
    process.uid !== userInfo().uid ||
    !process.started.trim() ||
    !Number.isSafeInteger(process.group) ||
    !process.group ||
    process.group <= 0
  )
    throw new Error('macOS fixture command has an invalid kernel identity.');
  return {
    pid,
    started: process.started,
    group: process.group,
    uid: process.uid,
  };
}

function sameIdentity(record: MacProcessGroup, current?: HostProcess) {
  return (
    current?.pid === record.pid &&
    current.started === record.started &&
    current.uid === record.uid &&
    current.group === record.group
  );
}

// Registration can fail after spawn. A captured identity still needs rechecking.
export function stopMacProcessGroup(
  record: MacProcessGroup,
  inspect = (pid: number) =>
    macProcessesSync().find((item) => item.pid === pid),
  kill = process.kill,
) {
  if (record.uid !== userInfo().uid) return false;
  try {
    if (!sameIdentity(record, inspect(record.pid))) return false;
    return kill(-record.group, 'SIGKILL');
  } catch {
    return false;
  }
}

// A live, unchanged member proves the group generation, even after reparenting.
// A group number alone is insufficient: the kernel can reuse it after exit.
export function recordMacProcessGroup(
  pid: number | undefined,
  inspect = (id: number) => macProcessesSync().find((item) => item.pid === id),
  mirror?: string,
) {
  const { directory, root } = requireMacProcessRegistry();
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0)
    throw new Error(
      'macOS fixture commands require the isolated process-group registry.',
    );
  const process = inspect(pid);
  // A command that already exited cannot leave this PID as an orphan.
  if (!process) return;
  const record: MacProcessGroup = { ...kernelIdentity(pid, process), root };
  try {
    for (const target of mirror ? [directory, mirror] : [directory])
      writeFileSync(resolve(target, `${pid}.json`), JSON.stringify(record), {
        mode: 0o600,
      });
  } catch {
    stopMacProcessGroup(record);
    throw new Error(
      'macOS fixture command could not register its process group.',
    );
  }
  return record;
}

export async function readMacProcessGroups(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some((entry) => entry.name.startsWith('pending-')))
    throw new Error(
      'Host isolation found a pending macOS process registration.',
    );
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && /^\d+\.json$/.test(entry.name))
      .map(
        async (entry) =>
          JSON.parse(
            await readFile(resolve(directory, entry.name), 'utf8'),
          ) as MacProcessGroup,
      ),
  );
  for (const record of records) {
    if (
      ![record.pid, record.group, record.root].every(
        (id) => Number.isSafeInteger(id) && id > 0,
      ) ||
      record.uid !== userInfo().uid ||
      typeof record.started !== 'string' ||
      !record.started.trim()
    )
      throw new Error(
        'Host isolation found an invalid macOS process-group record.',
      );
  }
  return records;
}
