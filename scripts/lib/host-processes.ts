import { readdir, readFile, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';

export type HostProcess = {
  pid: number;
  parent: number;
  started: string;
  name: string;
  home: string;
  run: string;
};

export async function readHostProcess(
  pid: number,
  proc = '/proc',
): Promise<HostProcess | undefined> {
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

function isParentRun(item: HostProcess, parentId?: string) {
  return parentId !== undefined && item.run === parentId;
}

export function orphanedProcesses(
  before: HostProcess[],
  after: HostProcess[],
  run: { id: string; pid: number; home: string; parentId?: string },
) {
  const baseline = new Set(before.map((item) => `${item.pid}:${item.started}`));
  return after.filter((item) => {
    if (item.pid === run.pid) return false;
    if (isParentRun(item, run.parentId)) return false;
    if (
      item.home.startsWith('/tmp/nook-cli-') ||
      item.home.startsWith(`${run.home}/`)
    )
      return true;
    const daemon = ['gnome-keyring-d', 'dbus-daemon'].includes(item.name);
    return (
      daemon &&
      !baseline.has(`${item.pid}:${item.started}`) &&
      (item.run === run.id || belongsToRun(item, after, run.pid))
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
    if (!current || current.started !== orphan.started) continue;
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
