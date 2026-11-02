import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { resolve } from 'node:path';

const [mode, expected, exit] = process.argv.slice(2);
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const value = () => process.env.GH_TOKEN ?? '';
if (mode === 'print-value') {
  writeSync(1, 'token=' + value() + '\n');
  process.exitCode = Number(expected ?? 0);
} else if (mode === 'shared-fifo') {
  const stdout = fstatSync(1);
  const stderr = fstatSync(2);
  writeSync(
    1,
    String(
      stdout.isFIFO() &&
        stderr.isFIFO() &&
        stdout.dev === stderr.dev &&
        stdout.ino === stderr.ino,
    ),
  );
} else if (mode === 'alternate') {
  for (let i = 0; i < 2000; i++)
    writeSync(i % 2 ? 2 : 1, `${i}:${i % 10 === 0 ? value() : 'plain'}\n`);
} else if (mode === 'separate') {
  writeSync(1, 'plain\n');
  writeSync(2, value());
} else if (mode === 'split-value') {
  const bytes = Buffer.from(value());
  writeSync(1, bytes.subarray(0, 8));
  setTimeout(() => writeSync(1, bytes.subarray(8)), 200);
} else if (mode === 'all-values') {
  for (const name of expected.split(',')) writeSync(1, process.env[name] + '|');
} else if (mode === 'multiline') {
  writeSync(1, value() + '|');
  for (const line of value().split('\n')) writeSync(1, '[' + line + ']\n');
} else if (mode === 'tty-value') {
  writeSync(
    1,
    JSON.stringify([
      !!process.stdin.isTTY,
      !!process.stdout.isTTY,
      !!process.stderr.isTTY,
    ]) + '\n',
  );
  writeSync(1, value());
  writeSync(2, value());
} else if (mode === 'prompt') {
  writeSync(1, 'Password: ');
  readSync(openSync(expected, 'r'), Buffer.alloc(1), 0, 1, null);
  writeSync(1, value());
} else if (mode === 'bytes') {
  writeSync(1, Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
} else if (mode === 'large') {
  writeFileSync(
    1,
    Buffer.concat([
      Buffer.alloc(1024 * 1024 - Buffer.byteLength(value()), 120),
      Buffer.from(value()),
    ]),
  );
} else if (mode === 'continuous-background') {
  spawn(process.execPath, [process.argv[1], 'continuous-writer', expected], {
    detached: true,
    stdio: 'inherit',
  }).unref();
  readSync(
    openSync(resolve(expected, 'writer-ready'), 'r'),
    Buffer.alloc(1),
    0,
    1,
    null,
  );
  writeFileSync(1, 'before:' + value() + '\n');
  process.exitCode = 3;
} else if (mode === 'continuous-writer') {
  writeFileSync(resolve(expected, 'writer-pid'), String(process.pid));
  const requests = openSync(resolve(expected, 'refill-requests'), 'r');
  const replies = openSync(resolve(expected, 'refill-replies'), 'w');
  writeFileSync(resolve(expected, 'writer-ready'), 'x');
  const record = Buffer.alloc(512, 46);
  Buffer.from(value()).copy(record);
  let offset = 0;
  const next = (size: number) => {
    const bytes = Buffer.alloc(size + record.length);
    bytes.fill(record);
    const chunk = bytes.subarray(offset, offset + size);
    offset = (offset + size) % record.length;
    return chunk;
  };
  let flowing = false;
  while (!flowing) {
    const header = Buffer.alloc(4);
    let received = 0;
    while (received < 4)
      received += readSync(requests, header, received, 4 - received, null);
    const size = header.readUInt32BE();
    if (size === 0xffffffff) {
      writeSync(replies, 'x');
      process.exit(0);
    }
    if (size) writeFileSync(2, next(size));
    else {
      flowing = true;
      writeFileSync(resolve(expected, 'writer-flowing'), 'x');
    }
    writeSync(replies, 'x');
  }
  let stopped = false;
  process.on('SIGTERM', () => {
    stopped = true;
  });
  const pump = () => {
    if (stopped) writeSync(2, 'after:' + value());
    else process.stdout.write(next(64 * 1024), pump);
  };
  pump();
} else if (mode === 'background') {
  spawn(process.execPath, [process.argv[1], 'background-writer', expected], {
    detached: true,
    stdio: 'inherit',
  }).unref();
  writeSync(1, 'before:' + value() + ':tail' + value().slice(0, 8));
  process.exitCode = 3;
} else if (mode === 'background-writer') {
  writeFileSync(resolve(expected, 'writer-pid'), String(process.pid));
  readSync(
    openSync(resolve(expected, 'release'), 'r'),
    Buffer.alloc(1),
    0,
    1,
    null,
  );
  writeSync(2, 'after:' + value());
} else if (mode === 'relay-private') {
  const launches = JSON.parse(
    readFileSync(resolve(expected, 'relay-launch'), 'utf8'),
  ) as { args: string[]; env: NodeJS.ProcessEnv };
  const values = [value(), process.env.NOOK_TEST_INHERITED ?? value()];
  const exposed = [...launches.args, ...Object.values(launches.env)].some(
    (entry) => values.some((value) => entry?.includes(value)),
  );
  writeSync(1, String(!exposed));
} else if (mode === 'signal-status') {
  for (const signal of ['SIGTERM', 'SIGHUP'] as const)
    process.on(signal, () => {
      writeSync(1, signal);
      process.exit(143);
    });
  writeSync(1, 'child-ready\n');
  setInterval(() => {}, 1000);
} else if (mode === 'streams') {
  const report = {
    valueMatches: hash(process.env.GH_TOKEN ?? '') === expected,
    aliasMatches:
      process.env.ALIAS === undefined ||
      process.env.ALIAS === process.env.GH_TOKEN,
    inherited: process.env.NOOK_TEST_INHERITED,
    tokenAbsent: !Object.values(process.env).some((value) =>
      value?.startsWith('nook_'),
    ),
    argvPrivate: !process.argv.some((arg) =>
      arg.includes(process.env.GH_TOKEN ?? 'never-match'),
    ),
    stdin: readFileSync(0, 'utf8'),
  };
  process.stdout.write(JSON.stringify(report) + '\nstdout-one\nstdout-two\n');
  process.stderr.write('stderr-one\nstderr-two\n');
  process.exitCode = Number(exit ?? '0');
} else if (mode === 'mappings') {
  const entries = JSON.parse(expected) as [string, string | null][];
  process.stdout.write(
    String(
      entries.every(([name, digest]) =>
        digest === null
          ? process.env[name] === undefined
          : hash(process.env[name] ?? '') === digest,
      ),
    ),
  );
  process.exitCode = Number(exit ?? '0');
} else if (mode === 'mark') {
  writeFileSync(expected, 'started');
  process.stdout.write('child-started');
} else if (mode === 'tty') {
  process.stdout.write(
    JSON.stringify([
      !!process.stdin.isTTY,
      !!process.stdout.isTTY,
      !!process.stderr.isTTY,
    ]) + '\n',
  );
} else if (mode === 'self-signal') {
  process.kill(process.pid, 'SIGTERM');
} else {
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const)
    process.on(signal, () => {
      process.stdout.write(signal + '\n');
      process.exit(0);
    });
  process.stdout.write('child-ready\n');
  if (mode === 'startup-wait')
    setTimeout(() => {
      process.stdout.write('signal-not-received\n');
      process.exit(23);
    }, 8000);
  setInterval(() => {}, 1000);
}
