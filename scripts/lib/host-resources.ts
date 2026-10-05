import { lstat, readdir, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

type Entry = { name: string; size: number; mtime: number; kind: string };
type DirectoryFingerprint = 'absent' | Entry[];
export type HostFingerprint = {
  directories: Record<string, DirectoryFingerprint>;
};

function ownerDataHome(parent: NodeJS.ProcessEnv, home: string) {
  const data = parent.XDG_DATA_HOME;
  if (!data || !isAbsolute(data)) return resolve(home, '.local/share');
  // Nested Vitest runs already have a temporary parent HOME/XDG tree.
  if (
    parent.HOME?.startsWith('/tmp/nook-test-run-') &&
    data === resolve(parent.HOME, 'data')
  )
    return resolve(home, '.local/share');
  return data;
}

export function ownerResources(parent: NodeJS.ProcessEnv, owner = userInfo()) {
  const home = owner.homedir;
  const realData = ownerDataHome(parent, home);
  return {
    directories: [
      ...new Set([
        resolve(home, '.local/share/keyrings'),
        resolve(realData, 'keyrings'),
        resolve(home, '.config/nook'),
      ]),
    ],
  };
}

async function directoryEntries(root: string, name = '.'): Promise<Entry[]> {
  const path = resolve(root, name);
  const info = await (name === '.' ? stat(path) : lstat(path));
  const entry = {
    name,
    size: info.size,
    mtime: info.mtimeMs,
    kind: info.isDirectory() ? 'directory' : 'entry',
  };
  if (!info.isDirectory()) return [entry];
  const children = await Promise.all(
    (await readdir(path))
      .sort()
      .map((child) => directoryEntries(root, `${name}/${child}`)),
  );
  return [entry, ...children.flat()];
}

export async function fingerprintDirectory(
  path: string,
): Promise<DirectoryFingerprint> {
  try {
    return await directoryEntries(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw new Error('Host isolation could not fingerprint an owner directory.');
  }
}

export async function fingerprintHost(resources: {
  directories: string[];
}): Promise<HostFingerprint> {
  const directories = Object.fromEntries(
    await Promise.all(
      resources.directories.map(async (path) => [
        path,
        await fingerprintDirectory(path),
      ]),
    ),
  );
  return { directories };
}

function entryChanges(
  before: Entry | undefined,
  after: Entry | undefined,
  metadata: boolean,
) {
  if (!before) return ['added'];
  if (!after) return ['removed'];
  const fields = metadata
    ? (['size', 'mtime', 'kind'] as const)
    : (['kind'] as const);
  return fields
    .filter((field) => before[field] !== after[field])
    .map((field) => `${field} changed`);
}

function directoryChanges(
  before: DirectoryFingerprint | undefined,
  after: DirectoryFingerprint | undefined,
  metadata: boolean,
) {
  const entries = (fingerprint: DirectoryFingerprint | undefined) =>
    new Map(
      (Array.isArray(fingerprint) ? fingerprint : []).map((entry) => [
        entry.name,
        entry,
      ]),
    );
  const previous = entries(before);
  const current = entries(after);
  return [...new Set([...previous.keys(), ...current.keys()])]
    .sort()
    .flatMap((name) =>
      entryChanges(previous.get(name), current.get(name), metadata).map(
        (change) => `${JSON.stringify(name)} ${change}`,
      ),
    );
}

function directoryIdentity(
  fingerprint: DirectoryFingerprint | undefined,
  metadata: boolean,
) {
  if (metadata || !Array.isArray(fingerprint)) return fingerprint;
  return fingerprint.map(({ name, kind }) => ({ name, kind }));
}

export function hostChanges(before: HostFingerprint, after: HostFingerprint) {
  const changes: string[] = [];
  for (const path of new Set([
    ...Object.keys(before.directories),
    ...Object.keys(after.directories),
  ])) {
    const keyrings = path.endsWith('/keyrings');
    if (
      JSON.stringify(directoryIdentity(before.directories[path], !keyrings)) !==
      JSON.stringify(directoryIdentity(after.directories[path], !keyrings))
    )
      changes.push(
        `${keyrings ? 'owner keyring directory changed' : 'owner Nook configuration directory changed'} (${JSON.stringify(path)}): ${directoryChanges(before.directories[path], after.directories[path], !keyrings).join(', ') || 'resource added or removed'}`,
      );
  }
  return [...new Set(changes)];
}

export function assertHostUnchanged(
  before: HostFingerprint,
  after: HostFingerprint,
  orphanMessages: string[] = [],
) {
  const changes = [...hostChanges(before, after), ...orphanMessages];
  if (changes.length)
    throw new Error(
      `Host isolation failed: ${changes.join('; ')}. Owner resources were not modified by cleanup.`,
    );
}
