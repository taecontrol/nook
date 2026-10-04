import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type SourceIdentity = { digest: string; files: Record<string, string> };
export const digest = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

export async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const lists = await Promise.all(
    entries
      .filter((entry) => entry.name !== 'node_modules')
      .map((entry) =>
        entry.isDirectory()
          ? files(join(directory, entry.name))
          : [join(directory, entry.name)],
      ),
  );
  return lists.flat().sort();
}

export async function sourceIdentity(): Promise<SourceIdentity> {
  const roots = [
    'apps',
    'packages',
    'scripts',
    'tests',
    'docs',
    '.github',
    'migrations',
  ];
  const paths = (await Promise.all(roots.map(files))).flat();
  paths.push(
    'AGENTS.md',
    'README.md',
    '.gitignore',
    '.oxlintrc.json',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'mise.toml',
    'tsconfig.json',
    'vite.config.ts',
    'vitest.config.ts',
    'e2e.config.ts',
    'biome.json',
    'coverage.config.json',
    'wrangler.jsonc',
  );
  const hashes: Record<string, string> = {};
  for (const path of paths.sort()) hashes[path] = digest(await readFile(path));
  return { files: hashes, digest: digest(JSON.stringify(hashes)) };
}
