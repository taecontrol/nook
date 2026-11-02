import fs, { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net, { type SocketConstructorOpts } from 'node:net';
import { resolve } from 'node:path';
import type { Writable } from 'node:stream';

// Observe real reads, writes and closes inside the private fixture.
const home = new URL(import.meta.url).searchParams.get('home');
if (!home) throw new Error('The lifecycle observer requires a private HOME.');
const events = resolve(home, 'lifecycle-events');
const { backpressure, pressure } = JSON.parse(
  readFileSync(resolve(home, 'observe-lifecycle'), 'utf8'),
) as { backpressure?: boolean; pressure?: string };
const originalRead = fs.read;
if (pressure === 'full-input') {
  let paused = false;
  fs.read = ((...args: Parameters<typeof fs.read>) => {
    if (args[0] >= 4 && !paused) {
      paused = true;
      fs.open(resolve(home, 'relay-release'), 'r', (error, fd) => {
        if (error) throw error;
        originalRead(fd, Buffer.alloc(1), 0, 1, null, () => {
          closeSync(fd);
          originalRead(...args);
        });
      });
      writeFileSync(events, 'read-paused\n');
      return;
    }
    return originalRead(...args);
  }) as typeof fs.read;
}
const originalWrite = fs.write;
fs.write = ((...args: Parameters<typeof fs.write>) => {
  if (![1, 2].includes(args[0])) return originalWrite(...args);
  const done = args.at(-1) as (...values: unknown[]) => void;
  const parameters = [...args];
  parameters[parameters.length - 1] = (
    error: NodeJS.ErrnoException | null,
    ...rest: unknown[]
  ) => {
    if (error) writeFileSync(events, `output-error:${error.code}\n`);
    done(error, ...rest);
    if (error?.code === 'EPIPE')
      setImmediate(() => writeFileSync(events, 'output-epipe\n'));
  };
  const result = Reflect.apply(originalWrite, fs, parameters);
  if (pressure) writeFileSync(events, 'output-write\n');
  if (backpressure && !reported) {
    reported = true;
    writeFileSync(events, 'output-backpressure\n');
  }
  return result;
}) as typeof fs.write;
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
