import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Observation } from './lib/coverage-evidence.ts';
import { evidenceRoot } from './lib/instrument.ts';

export async function observe(observation: Observation) {
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(
    resolve(evidenceRoot, `${observation.seam}-${crypto.randomUUID()}.json`),
    JSON.stringify(observation),
  );
}
