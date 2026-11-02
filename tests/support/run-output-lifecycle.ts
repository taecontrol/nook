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
// Writer cases use exec to preserve the started PID for SIGKILL and give both
// CLI streams the same anonymous pipe, which reports EOF on macOS. Spawn
// failures keep two independent pipes so both must close.
const child = spawn(
  mode === 'spawn-failure' ? process.execPath : '/bin/sh',
  mode === 'spawn-failure'
    ? [entry, ...args]
    : ['-c', 'exec "$@" 2>&1', 'fixture', process.execPath, entry, ...args],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
const exited = once(child, 'exit');
const output = child.stdout;
const stderrClosed = once(child.stderr, 'close');
const errors: Buffer[] = [];
child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
const outputClosed = once(output, 'close');
const chunks: Buffer[] = [];
let childReady: () => void;
const ready = new Promise<void>((accept) => {
  childReady = accept;
});
let outputReady: (() => void) | undefined;
const { beforeBytes } = JSON.parse(
  readFileSync(path('observe-lifecycle'), 'utf8'),
) as { beforeBytes: number };
output.on('data', (chunk: Buffer) => {
  chunks.push(chunk);
  if (Buffer.concat(chunks).includes('child-ready\n')) childReady();
  if (Buffer.concat(chunks).length >= beforeBytes) outputReady?.();
});
if (mode === 'backpressure') output.pause();
const prefixFlushed = () =>
  new Promise<void>((accept) => {
    outputReady = accept;
    if (Buffer.concat(chunks).length >= beforeBytes) accept();
  });
if (mode === 'killed') {
  await waitFor('child-ready');
  assert.equal(child.kill('SIGKILL'), true);
}
if (['SIGTERM', 'SIGHUP', 'SIGINT'].includes(mode)) {
  await ready;
  assert.equal(child.kill(mode as NodeJS.Signals), true);
  if (mode === 'SIGINT') assert.equal(child.kill('SIGTERM'), true);
}
if (mode === 'backpressure') {
  await waitFor('output-backpressure');
  output.resume();
}
const [status, signal] = await exited;
let secondWrite: string | undefined;
// A killed caller sends no token. Let its still-live child close the FIFO so
// the blocking reader, rather than control EOF, releases the held prefix.
if (mode === 'killed') writeSync(commands, 'x');
const atExit = Buffer.concat(chunks);
await prefixFlushed();
if (mode === 'epipe') {
  await waitFor('writer-ready');
  // The acknowledged token precedes run's exit; break output afterwards.
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
  await outputClosed;
  if (!args.includes('--no-masking')) await waitFor('relay-exit');
}
await stderrClosed;
lines.close();
events.destroy();
closeSync(commands);
process.stdout.write(
  JSON.stringify({
    status,
    signal,
    stdout: Buffer.concat(chunks).toString('base64'),
    stderr: Buffer.concat(errors).toString('base64'),
    atExit: atExit.toString('base64'),
    outputClosed: output.destroyed,
    stdoutClosed: output.readableEnded,
    stderrClosed: child.stderr.readableEnded,
    relayExited: received.has('relay-exit'),
    secondWrite,
    backpressured: received.has('output-backpressure'),
    outputErrors: [...received].filter((event) =>
      event.startsWith('output-error:'),
    ),
  }) + '\n',
);
