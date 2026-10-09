import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Inherited Node preloads may finish work after Nook's child has settled.
process.once('beforeExit', () => {
  const home = process.env.HOME;
  if (!home) throw new Error('The completion gate requires a private HOME.');
  writeFileSync(resolve(home, 'run-completed'), String(process.pid));
  process.stdout.write(`run-completed:${process.exitCode ?? 0}\n`);
  setTimeout(() => {
    process.stdout.write('signal-not-received\n');
    process.exit(23);
  }, 8000);
});
