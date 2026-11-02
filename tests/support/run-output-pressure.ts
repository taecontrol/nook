import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  closeSync,
  constants,
  existsSync,
  openSync,
  read,
  readFileSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { Socket } from 'node:net';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

// Coordinate real descriptor pressure with events; no sleep or time budget
// decides whether output was flushed or a full destination was noticed.
const [mode, entry, ...args] = process.argv.slice(2);
const home = process.env.HOME;
if (!home) throw new Error('The pressure fixture requires a private HOME.');
const path = (name: string) => resolve(home, name);
const names =
  mode === 'full-input'
    ? ['lifecycle-events', 'relay-release', 'writer-ready', 'writer-release']
    : ['lifecycle-events', 'destination', 'nonblocking-ready'];
assert.equal(spawnSync('/usr/bin/mkfifo', names.map(path)).status, 0);
writeFileSync(path('observe-lifecycle'), JSON.stringify({ pressure: mode }));
const events = new Socket({
  fd: openSync(
    path('lifecycle-events'),
    constants.O_RDWR | constants.O_NONBLOCK,
  ),
  readable: true,
  writable: false,
});
const lines = createInterface({ input: events });
const received = new Set<string>();
const waiting = new Map<string, () => void>();
lines.on('line', (line) => {
  received.add(line);
  waiting.get(line)?.();
  waiting.delete(line);
});
const waitFor = (event: string) =>
  new Promise<void>((accept) => {
    if (received.has(event)) accept();
    else waiting.set(event, accept);
  });
let reader = -1;
let padding = 0;
let fd: number;
if (mode === 'full-input') fd = openSync(path('output'), 'w');
else {
  const openingReader = openSync(
    path('destination'),
    constants.O_RDONLY | constants.O_NONBLOCK,
  );
  const nonblocking = openSync(
    path('destination'),
    constants.O_WRONLY | constants.O_NONBLOCK,
  );
  try {
    for (;;) padding += writeSync(nonblocking, Buffer.alloc(4096, 120));
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, 'EAGAIN');
  }
  try {
    for (;;) padding += writeSync(nonblocking, 'x');
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, 'EAGAIN');
  }
  fd =
    mode === 'nonblocking-output'
      ? nonblocking
      : openSync(path('destination'), constants.O_WRONLY);
  if (fd !== nonblocking) closeSync(nonblocking);
  reader = openSync(path('destination'), constants.O_RDONLY);
  closeSync(openingReader);
}
const child = spawn(process.execPath, [entry, ...args], {
  stdio: ['ignore', fd, fd],
});
const exited = once(child, 'exit');
closeSync(fd);
let atExit = Buffer.alloc(0);
const chunks: Buffer[] = [];
let status: number | null;
if (mode === 'full-input') {
  await waitFor('read-paused');
  await waitFor('token-queued');
  if (existsSync(path('token-write-error'))) {
    [status] = await exited;
    atExit = readFileSync(path('output'));
    writeFileSync(path('relay-release'), 'x');
  } else {
    writeFileSync(path('relay-release'), 'x');
    [status] = await exited;
    atExit = readFileSync(path('output'));
  }
  writeFileSync(path('writer-release'), 'x');
} else if (mode === 'fifo-epipe') {
  await waitFor('output-write');
  closeSync(reader);
  [status] = await exited;
  await waitFor('output-epipe');
} else {
  await waitFor('output-error:EAGAIN');
  const draining = (async () => {
    for (;;) {
      const bytes = Buffer.alloc(1024);
      const size = await new Promise<number>((accept, reject) =>
        read(reader, bytes, 0, bytes.length, null, (error, size) =>
          error ? reject(error) : accept(size),
        ),
      );
      if (!size) break;
      chunks.push(bytes.subarray(0, size));
    }
    closeSync(reader);
  })();
  [status] = await exited;
  await draining;
}
await waitFor('relay-exit');
if (mode === 'full-input') chunks.push(readFileSync(path('output')));
lines.close();
events.destroy();
process.stdout.write(
  JSON.stringify({
    status,
    atExit: atExit.toString('base64'),
    output: Buffer.concat(chunks).toString('base64'),
    padding,
    relayExited: received.has('relay-exit'),
    nonblocking: received.has('output-error:EAGAIN'),
  }) + '\n',
);
