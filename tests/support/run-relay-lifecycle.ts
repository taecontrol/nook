import fs, { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';

// Observe the real relay; never replace its reads, writes or close behavior.
const home = new URL(import.meta.url).searchParams.get('home');
if (!home) throw new Error('The lifecycle observer requires a private HOME.');
const events = resolve(home, 'lifecycle-events');
const createWriteStream = fs.createWriteStream;
fs.createWriteStream = (...args) => {
  const output = createWriteStream(...args);
  output.on('error', (error: NodeJS.ErrnoException) => {
    // Let all production error listeners finish closing readers first.
    if (error.code === 'EPIPE')
      setImmediate(() => writeFileSync(events, 'output-epipe\n'));
  });
  return output;
};
process.once('exit', () => writeFileSync(events, 'relay-exit\n'));
syncBuiltinESMExports();
