import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Manifest } from './coverage-evidence.ts';

export async function readEvidence(directory: string) {
  const manifest = JSON.parse(
    await readFile(resolve(directory, 'manifest.json'), 'utf8'),
  ) as Manifest;
  const artifacts: Record<string, string> = {};
  for (const name of Object.keys(manifest.outputs)) {
    if (!/^[\w-]+\.json$/.test(name))
      throw new Error('Coverage artifact outside namespace');
    artifacts[name] = await readFile(resolve(directory, name), 'utf8');
  }
  return { manifest, artifacts };
}
