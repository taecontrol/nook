import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const [mode, entry] = process.argv.slice(2);
const args = [
  'vault',
  'create',
  'work/acme/NEW_TOKEN',
  '--purpose',
  'token from provider setup',
];
const terminal = mode.startsWith('tty');
const typed = terminal
  ? mode === 'tty-invalid'
    ? Buffer.from([0xc3, 0x28, 0x0a])
    : readFileSync(0)
  : undefined;
const command = [process.execPath, entry, ...args]
  .map((arg) => "'" + arg.replaceAll("'", "'\\''") + "'")
  .join(' ');
const child = terminal
  ? spawn('/usr/bin/script', [
      '--quiet',
      '--return',
      '--command',
      mode === 'tty-split' ? `exec ${command}` : command,
      '/dev/null',
    ])
  : spawn(process.execPath, [entry, ...args]);
let output = '';
let supplied = false;
async function splitInput() {
  const descendants = await readFile(
    `/proc/${child.pid}/task/${child.pid}/children`,
    'utf8',
  );
  const pid = descendants.trim().split(/\s+/)[0];
  const consumed = async () =>
    Number(
      /^rchar:\s*(\d+)/m.exec(await readFile(`/proc/${pid}/io`, 'utf8'))?.[1],
    );
  const before = await consumed();
  child.stdin.write(typed!.subarray(0, 1));
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      if ((await consumed()) > before) {
        child.stdin.end(typed!.subarray(1));
        return;
      }
    } catch {
      return;
    }
  }
  throw new Error('TTY fixture could not observe its private child reading.');
}
child.stdout.on('data', (chunk) => {
  output += String(chunk);
  process.stdout.write(chunk);
  if (
    typed &&
    !supplied &&
    output.includes('Value for work/acme/NEW_TOKEN: ')
  ) {
    supplied = true;
    if (mode === 'tty-split')
      void splitInput().catch(() => {
        process.stderr.write(
          'TTY fixture could not observe its private child reading.\n',
        );
        child.kill('SIGKILL');
      });
    else if (mode === 'tty-open') child.stdin.write(typed);
    else child.stdin.end(typed);
  }
});
child.stderr.pipe(process.stderr);
child.stdin.on('error', () => {});
child.on('close', (code) => {
  process.exitCode = code ?? 1;
});
if (mode === 'invalid-utf8') child.stdin.end(Buffer.from([0xc3, 0x28]));
if (mode === 'open-pipe') child.stdin.write(Buffer.alloc(100_000, 0x61));
