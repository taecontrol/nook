import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [mode, entry] = process.argv.slice(2);
const args = [
  'vault',
  'create',
  'work/acme/NEW_TOKEN',
  '--purpose',
  'token from provider setup',
];
const typed = mode === 'tty' ? readFileSync(0) : undefined;
const command = [process.execPath, entry, ...args]
  .map((arg) => "'" + arg.replaceAll("'", "'\\''") + "'")
  .join(' ');
const child =
  mode === 'tty'
    ? spawn('/usr/bin/script', [
        '--quiet',
        '--return',
        '--command',
        command,
        '/dev/null',
      ])
    : spawn(process.execPath, [entry, ...args]);
let output = '';
let supplied = false;
child.stdout.on('data', (chunk) => {
  output += String(chunk);
  process.stdout.write(chunk);
  if (
    typed &&
    !supplied &&
    output.includes('Value for work/acme/NEW_TOKEN: ')
  ) {
    supplied = true;
    child.stdin.end(typed);
  }
});
child.stderr.pipe(process.stderr);
child.stdin.on('error', () => {});
child.on('close', (code) => {
  process.exitCode = code ?? 1;
});
if (mode === 'invalid-utf8') child.stdin.end(Buffer.from([0xc3, 0x28]));
if (mode === 'open-pipe') child.stdin.write(Buffer.alloc(100_000, 0x61));
