import { readFile } from 'node:fs/promises';
import { analyze } from './lib/crap-analysis.ts';
import { instrument, inventory } from './lib/instrument.ts';

const failures = [];
for (const file of await inventory(true)) {
  const { baseline } = await instrument(file);
  for (const row of analyze(await readFile(file, 'utf8'), baseline)) {
    if (row.complexity > 8) failures.push({ file, ...row });
  }
}
console.log(JSON.stringify({ maximum: 8, failures }, null, 2));
if (failures.length) process.exitCode = 1;
