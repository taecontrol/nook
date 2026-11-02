import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  closeSync,
  constants,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { Socket } from 'node:net';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

// All progress is driven by FIFO messages, output bytes and process events.
// A broken lifecycle hangs until the suite timeout, never a local time budget.
const [mode, entry, ...args] = process.argv.slice(2);
const home = process.env.HOME;
if (!home) throw new Error('The lifecycle fixture requires a private HOME.');
const path = (name: string) => resolve(home, name);
assert.equal(
  spawnSync('/usr/bin/mkfifo', [
    path('lifecycle-output'),
    path('lifecycle-events'),
    path('lifecycle-commands'),
  ]).status,
  0,
);
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
const waitFor = (name: string) =>
  new Promise<void>((accept) => {
    if (received.has(name)) accept();
    else waiting.set(name, accept);
  });
const commands = openSync(path('lifecycle-commands'), constants.O_RDWR);
const output = new Socket({
  fd: openSync(
    path('lifecycle-output'),
    constants.O_RDONLY | constants.O_NONBLOCK,
  ),
  readable: true,
  writable: false,
});
const outputClosed = once(output, 'close');
const chunks: Buffer[] = [];
let outputReady: (() => void) | undefined;
const { beforeBytes } = JSON.parse(
  readFileSync(path('observe-lifecycle'), 'utf8'),
) as { beforeBytes: number };
output.on('data', (chunk: Buffer) => {
  chunks.push(chunk);
  if (Buffer.concat(chunks).length >= beforeBytes) outputReady?.();
});
const prefixFlushed = () =>
  new Promise<void>((accept) => {
    outputReady = accept;
    if (Buffer.concat(chunks).length >= beforeBytes) accept();
  });
const destination = openSync(path('lifecycle-output'), 'w');
const child = spawn(process.execPath, [entry, ...args], {
  stdio: ['ignore', destination, destination],
});
const exited = once(child, 'exit');
closeSync(destination);
if (mode === 'killed') {
  await waitFor('child-ready');
  assert.equal(child.kill('SIGKILL'), true);
}
const [status, signal] = await exited;
let secondWrite: string | undefined;
await prefixFlushed();
const atExit = Buffer.concat(chunks);
if (mode === 'epipe') {
  await waitFor('writer-ready');
  // The acknowledged flush precedes run's exit, so this breaks output only
  // after the relay has switched to its blocking FIFO reader.
  output.destroy();
  await outputClosed;
  writeSync(commands, 'w');
  await waitFor('write-ok');
  await waitFor('output-epipe');
  writeSync(commands, 'w');
  await waitFor('second-write');
  secondWrite = readFileSync(path('second-write'), 'utf8');
  // The writer remains idle with stdout/stderr open until the relay exits.
  await waitFor('relay-exit');
  writeSync(commands, 'x');
  await waitFor('writer-done');
} else {
  if (mode === 'killed') writeSync(commands, 'x');
  await outputClosed;
  if (!args.includes('--no-masking')) await waitFor('relay-exit');
}
lines.close();
events.destroy();
closeSync(commands);
process.stdout.write(
  JSON.stringify({
    status,
    signal,
    stdout: Buffer.concat(chunks).toString('base64'),
    atExit: atExit.toString('base64'),
    outputClosed: output.destroyed,
    relayExited: received.has('relay-exit'),
    secondWrite,
  }) + '\n',
);
