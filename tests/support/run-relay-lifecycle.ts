import fs, { closeSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';

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
let reported = false;
fs.write = ((...args: Parameters<typeof fs.write>) => {
  if (![1, 2].includes(args[0])) return originalWrite(...args);
  const done = args.at(-1) as (...values: unknown[]) => void;
  const parameters = [...args];
  parameters[parameters.length - 1] = (
    error: NodeJS.ErrnoException | null,
    ...rest: unknown[]
  ) => {
    if (error) writeFileSync(events, `output-error:${error.code}\n`);
    if (backpressure && error?.code === 'EAGAIN' && !reported) {
      reported = true;
      writeFileSync(events, 'output-backpressure\n');
    }
    done(error, ...rest);
    if (error?.code === 'EPIPE')
      setImmediate(() => writeFileSync(events, 'output-epipe\n'));
  };
  const result = Reflect.apply(originalWrite, fs, parameters);
  if (pressure) writeFileSync(events, 'output-write\n');
  return result;
}) as typeof fs.write;
process.once('exit', () => writeFileSync(events, 'relay-exit\n'));
syncBuiltinESMExports();
