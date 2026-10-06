import { spawnSync } from 'node:child_process';
import { mkdir, readFile, stat, statfs, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

export type Probe = {
  owner: { home: string; uid: number; data: string; directories: string[] };
  binds: string[];
  mode: 'escape' | 'empty' | 'readonly';
  sentinel?: string;
  marker?: string;
  files?: string[];
};

async function absent(path: string) {
  try {
    await stat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

function mountParents(root: string, binds: string[]) {
  const parents = new Map<string, Set<string>>([[root, new Set()]]);
  for (const bind of binds) {
    if (!bind.startsWith(`${root}${sep}`)) continue;
    // A nested bind within an already bound tree creates no tmpfs parents.
    if (
      binds.some(
        (ancestor) => ancestor !== bind && bind.startsWith(`${ancestor}${sep}`),
      )
    )
      continue;
    let child = bind;
    while (child !== root) {
      const parent = dirname(child);
      const children = parents.get(parent) ?? new Set<string>();
      children.add(child);
      parents.set(parent, children);
      child = parent;
    }
  }
  return parents;
}

async function emptyParents(root: string, binds: string[]) {
  if (await absent(root)) return true;
  // Linux tmpfs directories account for '.' and '..' plus 20 bytes per
  // entry. Stat metadata detects unexpected entries without listing owner
  // paths or opening anything beneath them, even with a broken sandbox.
  // https://github.com/torvalds/linux/blob/master/mm/shmem.c (BOGO_DIRENT_SIZE)
  for (const [parent, children] of mountParents(root, binds)) {
    if ((await statfs(parent)).type !== 0x01021994) return false;
    if ((await stat(parent)).size !== 40 + 20 * children.size) return false;
  }
  return true;
}

export async function statGate(probe: Probe) {
  for (const path of [
    ...probe.owner.directories,
    `/run/user/${probe.owner.uid}/bus`,
  ])
    if (!(await absent(path))) return false;
  for (const path of [probe.owner.home, probe.owner.data])
    if (!(await emptyParents(path, probe.binds))) return false;
  return true;
}

async function escapeProbe(probe: Probe) {
  process.env.XDG_DATA_HOME = probe.owner.data;
  process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=/run/user/${probe.owner.uid}/bus`;
  const store = spawnSync(
    '/usr/bin/secret-tool',
    ['store', '--label=Synthetic sandbox probe', 'service', 'nook-sandbox'],
    {
      input: 'synthetic-only',
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: 2000,
    },
  );
  const lookup = spawnSync(
    '/usr/bin/secret-tool',
    ['lookup', 'service', 'nook-sandbox'],
    { stdio: 'ignore', timeout: 2000 },
  );
  if (!probe.marker || !probe.sentinel)
    throw new Error('Escape probe requires synthetic paths.');
  const keyrings = resolve(probe.owner.data, 'keyrings');
  await mkdir(keyrings, { recursive: true });
  await writeFile(resolve(keyrings, probe.marker), 'synthetic-only');
  let sentinelReadable = true;
  try {
    await readFile(probe.sentinel);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    sentinelReadable = false;
  }
  return {
    store: store.status,
    lookup: lookup.status,
    wrote: true,
    sentinelReadable,
  };
}

async function readonly(probe: Probe) {
  const errors: string[] = [];
  if (!probe.files)
    throw new Error('Read-only probe requires synthetic files.');
  for (const path of probe.files) {
    try {
      await writeFile(path, 'changed');
      errors.push('writable');
    } catch (error) {
      errors.push((error as NodeJS.ErrnoException).code ?? 'unknown');
    }
  }
  return { errors };
}

export async function probeSandbox(probe: Probe) {
  if (!(await statGate(probe))) {
    process.stdout.write(`${JSON.stringify({ gate: false })}\n`);
    process.exit(3);
  }
  const result =
    probe.mode === 'escape'
      ? await escapeProbe(probe)
      : probe.mode === 'readonly'
        ? await readonly(probe)
        : {};
  process.stdout.write(`${JSON.stringify({ gate: true, ...result })}\n`);
  process.exit(0);
}
