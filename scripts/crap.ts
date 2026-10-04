import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateCounters, validateCoverage } from './lib/coverage-evidence.ts';
import { analyze } from './lib/crap-analysis.ts';
import { readEvidence } from './lib/evidence-io.ts';
import { sourceIdentity } from './lib/identity.ts';
import { evidenceRoot, instrument, inventory } from './lib/instrument.ts';

const source = await sourceIdentity();
const input = await readEvidence(evidenceRoot);
const { baseline, seen } = validateCoverage(
  input.manifest,
  input.artifacts,
  source,
);
const paths = await inventory();
if (JSON.stringify(paths) !== JSON.stringify(Object.keys(baseline)))
  throw new Error('Coverage source inventory changed');
const rows = [];
for (const file of paths) {
  const fresh = await instrument(file);
  validateCounters(fresh.baseline, baseline[file].baseline);
  for (const row of analyze(
    await readFile(file, 'utf8'),
    baseline[file].baseline,
  ))
    rows.push({ file, executed: seen.has(file), ...row });
}
const failures = rows.filter((row) => row.score > 8);
await writeFile(
  resolve(evidenceRoot, 'crap.json'),
  JSON.stringify(
    { source: source.digest, maximum: 8, rows, failures },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({ functions: rows.length, maximum: 8, failures }, null, 2),
);
if (failures.length) process.exitCode = 1;
