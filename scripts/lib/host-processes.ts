import { readdir, readFile, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import type { MacProcessGroup } from './macos-process-groups.ts';
import { macProcesses } from './macos-processes.ts';

export type HostProcess = {
  pid: number;
  parent: number;
  started: string;
  name: string;
  home: string;
  run: string;
  group?: number;
  uid?: number;
};

export async function readHostProcess(
  pid: number,
  proc = '/proc',
): Promise<HostProcess | undefined> {
  if (process.platform === 'darwin' && proc === '/proc')
    return (await macProcesses()).find((item) => item.pid === pid);
  try {
    const root = resolve(proc, String(pid));
    if ((await stat(root)).uid !== userInfo().uid) return undefined;
    const status = await readFile(resolve(root, 'stat'), 'utf8');
    const fields = status.slice(status.lastIndexOf(')') + 2).split(' ');
    const env = (await readFile(resolve(root, 'environ'), 'utf8')).split('\0');
    const value = (key: string) =>
      env.find((entry) => entry.startsWith(`${key}=`))?.slice(key.length + 1) ??
      '';
    return {
      pid,
      parent: Number(fields[1]),
      started: fields[19],
      name: (await readFile(resolve(root, 'comm'), 'utf8')).trim(),
      home: value('HOME'),
      run: value('NOOK_TEST_RUN'),
    };
  } catch (error) {
    if (
      ['ENOENT', 'ESRCH', 'EACCES'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )
    )
      return undefined;
    throw new Error('Host isolation could not inspect a process.');
  }
}

export async function snapshotProcesses(proc = '/proc') {
  if (process.platform === 'darwin' && proc === '/proc') return macProcesses();
  const pids = (await readdir(proc)).filter((name) => /^\d+$/.test(name));
  const processes = await Promise.all(
    pids.map((pid) => readHostProcess(Number(pid), proc)),
  );
  return processes.filter((item): item is HostProcess => item !== undefined);
}

function belongsToRun(
  item: HostProcess,
  processes: HostProcess[],
  root: number,
) {
  const visited = new Set<number>();
  let parent = item.parent;
  while (parent && !visited.has(parent)) {
    if (parent === root) return true;
    visited.add(parent);
    parent = processes.find((process) => process.pid === parent)?.parent ?? 0;
  }
  return false;
}

function ownsFixtureHome(item: HostProcess, run: ProcessRun) {
  return (
    (run.homes ?? []).includes(item.home) ||
    item.home.startsWith(`${run.home}/`)
  );
}

export type ProcessRun = {
  id: string;
  pid: number;
  home: string;
  homes?: string[];
  groups?: MacProcessGroup[];
  uid?: number;
};

function registeredGroups(run: ProcessRun) {
  return (run.groups ?? []).filter(
    (record) =>
      record.root === run.pid && record.uid === (run.uid ?? userInfo().uid),
  );
}

function liveGroups(after: HostProcess[], run: ProcessRun) {
  const current = new Map(after.map((item) => [item.pid, item]));
  return new Set(
    registeredGroups(run)
      .filter((record) => {
        const item = current.get(record.pid);
        return (
          item?.started === record.started &&
          item.uid === record.uid &&
          item.group === record.group
        );
      })
      .map((record) => record.group),
  );
}

function newMacProcesses(
  before: HostProcess[],
  after: HostProcess[],
  run: ProcessRun,
) {
  const baseline = new Set(before.map((item) => `${item.pid}:${item.started}`));
  return after.filter(
    (item) =>
      item.pid !== run.pid &&
      item.uid === (run.uid ?? userInfo().uid) &&
      !baseline.has(`${item.pid}:${item.started}`),
  );
}

// A fixture's private journal limits cleanup to its groups, without run ancestry.
export function macGroupProcesses(
  before: HostProcess[],
  after: HostProcess[],
  run: ProcessRun,
) {
  const registered = new Set(
    registeredGroups(run).map((record) => record.group),
  );
  const live = liveGroups(after, run);
  const fresh = newMacProcesses(before, after, run);
  return {
    owned: fresh.filter((item) => live.has(item.group ?? -1)),
    ambiguous: fresh.filter(
      (item) => registered.has(item.group ?? -1) && !live.has(item.group ?? -1),
    ),
  };
}

// A stale number cannot authorize a signal. Report ambiguity and fail closed.
export function unverifiedMacProcesses(
  before: HostProcess[],
  after: HostProcess[],
  run: ProcessRun,
) {
  return macGroupProcesses(before, after, run).ambiguous.filter(
    (item) => !belongsToRun(item, after, run.pid),
  );
}

export function orphanedProcesses(
  before: HostProcess[],
  after: HostProcess[],
  run: ProcessRun,
  platform = process.platform,
) {
  const baseline = new Set(before.map((item) => `${item.pid}:${item.started}`));
  if (platform === 'darwin') {
    const owned = new Set(
      macGroupProcesses(before, after, run).owned.map((item) => item.pid),
    );
    return newMacProcesses(before, after, run).filter(
      (item) => owned.has(item.pid) || belongsToRun(item, after, run.pid),
    );
  }
  return after.filter((item) => {
    if (item.pid === run.pid) return false;
    if (baseline.has(`${item.pid}:${item.started}`)) return false;
    if (item.run && item.run !== run.id) return false;
    if (ownsFixtureHome(item, run)) return true;
    const daemon = ['gnome-keyring-d', 'dbus-daemon'].includes(item.name);
    return (
      daemon && (item.run === run.id || belongsToRun(item, after, run.pid))
    );
  });
}

export async function killOrphans(
  orphans: HostProcess[],
  inspect = readHostProcess,
  kill = process.kill,
) {
  const messages: string[] = [];
  for (const orphan of orphans) {
    const current = await inspect(orphan.pid);
    if (
      !current ||
      current.started !== orphan.started ||
      current.uid !== orphan.uid ||
      current.group !== orphan.group
    )
      continue;
    try {
      kill(orphan.pid, 'SIGKILL');
      messages.push(`orphaned test process PID ${orphan.pid} terminated`);
    } catch {
      messages.push(
        `orphaned test process PID ${orphan.pid} could not be terminated`,
      );
    }
  }
  return messages;
}
