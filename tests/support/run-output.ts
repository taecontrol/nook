import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Keep binary streams and shared file descriptors intact inside the sandbox.
const [mode, entry, ...args] = process.argv.slice(2);
const home = process.env.HOME;
if (!home) throw new Error('The output fixture requires a private HOME.');
const file = resolve(home, 'output');
const background = [
  'background',
  'background-separate',
  'continuous-background',
].includes(mode);
const fd = mode === 'shared' || background ? openSync(file, 'w') : undefined;
const stderrFd =
  mode === 'background-separate'
    ? openSync(resolve(home, 'output-error'), 'w')
    : fd;
const child = spawn(process.execPath, [entry, ...args], {
  stdio: ['ignore', fd ?? 'pipe', stderrFd ?? 'pipe'],
});
const exited = once(child, 'exit');
const closed = once(child, 'close');
if (fd !== undefined) closeSync(fd);
if (stderrFd !== undefined && stderrFd !== fd) closeSync(stderrFd);
const stdout: Buffer[] = [];
const stderr: Buffer[] = [];
child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
if (mode === 'head') {
  if (!child.stdout) throw new Error('The pipe fixture requires stdout.');
  const head = spawn('/usr/bin/head', ['-1'], {
    stdio: [child.stdout, 'pipe', 'inherit'],
  });
  child.stdout.destroy();
  head.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  await once(head, 'close');
} else
  child.stdout?.on('data', (chunk) => {
    stdout.push(Buffer.from(chunk));
    if (mode === 'prompt' && Buffer.concat(stdout).toString() === 'Password: ')
      spawnSync('/bin/sh', [
        '-c',
        'printf x > "$1"',
        'fixture',
        resolve(home, 'release'),
      ]);
  });
const [status] = await exited;
if (background) {
  // The test releases the writer only after examining this exit-time snapshot.
  writeFileSync(resolve(home, 'exit-snapshot'), readFileSync(file));
  process.stdout.write(JSON.stringify({ status }) + '\n');
} else {
  // close is later than exit for a pipe; E17 deliberately snapshots at exit.
  const atExit = fd === undefined ? Buffer.concat(stdout) : readFileSync(file);
  await closed;
  process.stdout.write(
    JSON.stringify({
      status,
      stdout: atExit.toString('base64'),
      stderr: Buffer.concat(stderr).toString('base64'),
      stdoutClosed: child.stdout?.readableEnded,
      stderrClosed: child.stderr?.readableEnded,
    }) + '\n',
  );
}
