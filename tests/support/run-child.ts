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
} else if (mode === 'full-input-writer') {
  // Constructing Node's stdout changes its shared open file description to
  // O_NONBLOCK, including the child's writer retained by nook run.
  void process.stdout;
  const record = Buffer.from(value() + '\n');
  let records = 0;
  let padding = 0;
  try {
    for (;;) {
      writeSync(1, record);
      records++;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
  }
  try {
    for (;;) {
      writeSync(1, 'x');
      padding++;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
  }
  writeFileSync(
    resolve(expected, 'full-input-counts'),
    JSON.stringify({ records, padding }),
  );
  writeFileSync(resolve(expected, 'writer-ready'), 'x\n');
  readSync(
    openSync(resolve(expected, 'writer-release'), 'r'),
    Buffer.alloc(1),
    0,
    1,
    null,
  );
  process.stdout.write('after:' + value());
} else if (mode === 'continuous-background') {
  writeFileSync(1, 'before:' + value() + '\n');
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
  process.exitCode = 3;
} else if (mode === 'continuous-writer') {
  writeFileSync(resolve(expected, 'writer-pid'), String(process.pid));
  const configuration = JSON.parse(
    readFileSync(resolve(expected, 'continuous-output'), 'utf8'),
  ) as { record: string };
  const record =
    configuration.record === 'unpadded'
      ? Buffer.from(value())
      : Buffer.alloc(512, 46);
  Buffer.from(value()).copy(record);
  let stopped = false;
  process.on('SIGTERM', () => {
    stopped = true;
  });
  const pump = () => {
    if (stopped) process.stdout.write('after:' + value());
    // Complete records fit PIPE_BUF; the token can fall only between values.
    // Yield so the test's SIGTERM can stop this otherwise continuous writer.
    else process.stdout.write(record, () => setImmediate(pump));
  };
  writeFileSync(2, record);
  writeFileSync(resolve(expected, 'writer-flowing'), 'x');
  writeFileSync(resolve(expected, 'writer-ready'), 'x');
  pump();
} else if (mode === 'background' || mode === 'background-epipe') {
  spawn(
    process.execPath,
    [
      process.argv[1],
      mode === 'background' ? 'background-writer' : 'epipe-writer',
      expected,
    ],
    { detached: true, stdio: 'inherit' },
  ).unref();
  writeSync(1, 'before:' + value() + ':tail' + value().slice(0, 8));
  process.exitCode = 3;
} else if (mode === 'epipe-writer' || mode === 'killed-parent') {
  const events = openSync(resolve(expected, 'lifecycle-events'), 'w');
  const commands = openSync(resolve(expected, 'lifecycle-commands'), 'r');
  if (mode === 'killed-parent')
    writeSync(1, 'before:' + value() + ':tail' + value().slice(0, 8));
  writeSync(
    events,
    mode === 'epipe-writer' ? 'writer-ready\n' : 'child-ready\n',
  );
  const command = Buffer.alloc(1);
  let writes = 0;
  while (readSync(commands, command, 0, 1, null) && command[0] !== 120) {
    let result = 'accepted';
    try {
      writeSync(1, 'after:' + value());
    } catch (error) {
      result = (error as NodeJS.ErrnoException).code ?? 'unknown';
    }
    if (++writes === 1) writeSync(events, 'write-ok\n');
    else {
      writeFileSync(resolve(expected, 'second-write'), result);
      writeSync(events, 'second-write\n');
    }
  }
  if (mode === 'killed-parent')
    writeSync(2, 'after:' + value() + ':tail' + value().slice(0, 8));
  writeSync(events, 'writer-done\n');
} else if (mode === 'background-writer') {
  writeFileSync(resolve(expected, 'writer-pid'), String(process.pid));
  readSync(
    openSync(resolve(expected, 'release'), 'r'),
    Buffer.alloc(1),
    0,
    1,
    null,
  );
  writeSync(2, '\0nook-flush:near-match:' + value() + '\0nook-flush:');
} else if (mode === 'relay-private') {
  const launches = JSON.parse(
    readFileSync(resolve(expected, 'relay-launch'), 'utf8'),
  ) as { args: string[]; env: NodeJS.ProcessEnv };
  const token = readFileSync(resolve(expected, 'flush-token'), 'utf8');
  const values = [
    value(),
    process.env.NOOK_TEST_INHERITED ?? value(),
    token,
    token.slice('\0nook-flush:'.length, -1),
  ];
  const exposed = [...launches.args, ...Object.values(launches.env)].some(
    (entry) => values.some((value) => entry?.includes(value)),
  );
  writeSync(1, String(!exposed));
} else if (mode === 'signal-status') {
  for (const signal of ['SIGTERM', 'SIGHUP'] as const)
    process.on(signal, () => {
      writeSync(1, signal + ':' + value() + ':tail' + value().slice(0, 8));
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
