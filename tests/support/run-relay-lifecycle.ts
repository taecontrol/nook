import fs, { readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net, { type SocketConstructorOpts } from 'node:net';
import { resolve } from 'node:path';
import type { Writable } from 'node:stream';

// Observe real reads, writes and closes. The backpressure case lowers only the
// stream's highWaterMark so even a partial FIFO read exercises write pressure.
const home = new URL(import.meta.url).searchParams.get('home');
if (!home) throw new Error('The lifecycle observer requires a private HOME.');
const events = resolve(home, 'lifecycle-events');
const { backpressure } = JSON.parse(
  readFileSync(resolve(home, 'observe-lifecycle'), 'utf8'),
) as { backpressure?: boolean };
let reported = false;
function observe(output: Writable) {
  if (backpressure) {
    const write = output.write;
    output.write = function (
      this: typeof output,
      ...parameters: Parameters<typeof output.write>
    ) {
      const accepted = write.apply(this, parameters);
      if (!accepted && !reported) {
        reported = true;
        writeFileSync(events, 'output-backpressure\n');
      }
      return accepted;
    } as typeof output.write;
  }
  output.on('error', (error: NodeJS.ErrnoException) => {
    if (backpressure) writeFileSync(events, `output-error:${error.code}\n`);
    // Let all production error listeners finish closing readers first.
    if (error.code === 'EPIPE')
      setImmediate(() => writeFileSync(events, 'output-epipe\n'));
  });
}
const createWriteStream = fs.createWriteStream;
fs.createWriteStream = (...args) => {
  if (backpressure && typeof args[1] === 'object')
    args[1] = { ...args[1], highWaterMark: 1 };
  const output = createWriteStream(...args);
  observe(output);
  return output;
};
net.Socket = class extends net.Socket {
  constructor(options: SocketConstructorOpts = {}) {
    const output =
      options.writable === true && [1, 2].includes(options.fd ?? -1);
    const settings =
      output && backpressure ? { ...options, highWaterMark: 1 } : options;
    super(settings);
    if (output) observe(this);
  }
};
process.once('exit', () => writeFileSync(events, 'relay-exit\n'));
syncBuiltinESMExports();
