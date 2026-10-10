import { readdir, readFile, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, isAbsolute, resolve } from 'node:path';

type FixtureHome = { run: string; home: string };

function validHome(home: unknown): home is string {
  return (
    typeof home === 'string' &&
    isAbsolute(home) &&
    resolve(home) === home &&
    home !== userInfo().homedir &&
    basename(home).startsWith('nook-cli-')
  );
}

function validRecord(value: unknown): value is FixtureHome {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.run === 'string' &&
    record.run.trim() !== '' &&
    validHome(record.home)
  );
}

// Register before launch; retain provenance even if close removes a leaked HOME.
export async function registerLinuxFixtureHome(
  directory: string,
  run: string,
  home: string,
) {
  try {
    await writeFile(
      resolve(directory, `${crypto.randomUUID()}.json`),
      JSON.stringify({ run, home }),
      { mode: 0o600, flag: 'wx' },
    );
  } catch {
    throw new Error('Linux CLI fixture HOME could not be registered.');
  }
}

export async function readLinuxFixtureHomes(directory: string, run: string) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => !entry.isFile())) throw new Error();
    const records: unknown[] = await Promise.all(
      entries.map(async (entry) =>
        JSON.parse(await readFile(resolve(directory, entry.name), 'utf8')),
      ),
    );
    if (!records.every(validRecord)) throw new Error();
    return records
      .filter((record) => record.run === run)
      .map(({ home }) => home);
  } catch {
    throw new Error(
      'Host isolation found an invalid Linux fixture HOME registry.',
    );
  }
}
