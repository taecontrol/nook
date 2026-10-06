import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateArtifacts, validateShards } from './lib/coverage-evidence.ts';
import { readEvidence } from './lib/evidence-io.ts';
import { digest, sourceIdentity } from './lib/identity.ts';
import { evidenceRoot } from './lib/instrument.ts';

const directories = process.argv.slice(2);
const source = await sourceIdentity();
const shards = await Promise.all(directories.map(readEvidence));
validateShards(
  shards.map((shard) => shard.manifest),
  source,
);
const baselineHash = shards[0].manifest.outputs['baseline.json'];
const artifacts: Record<string, string> = {};
for (const shard of shards) {
  validateArtifacts(shard.manifest, shard.artifacts, source);
  if (shard.manifest.outputs['baseline.json'] !== baselineHash)
    throw new Error('Coverage shards disagree on the source baseline');
  for (const [name, data] of Object.entries(shard.artifacts)) {
    if (name !== 'baseline.json' && artifacts[name] !== undefined)
      throw new Error(`Repeated coverage artifact ${name}`);
    artifacts[name] = data;
  }
}
await rm(evidenceRoot, { recursive: true, force: true });
await mkdir(evidenceRoot, { recursive: true });
const outputs: Record<string, string> = {};
for (const [name, data] of Object.entries(artifacts)) {
  await writeFile(resolve(evidenceRoot, name), data);
  outputs[name] = digest(data);
}
await writeFile(
  resolve(evidenceRoot, 'manifest.json'),
  JSON.stringify({ schema: 1, source, shards: 4, outputs }, null, 2),
);
console.log('Merged all three Linux coverage shards and macOS.');
