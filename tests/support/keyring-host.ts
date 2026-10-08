import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { testEnvironment } from '../../scripts/lib/test-environment.ts';

// This process lives inside dbus-run-session. Never inherit the owner's bus.
if (!process.env.DBUS_SESSION_BUS_ADDRESS?.startsWith('unix:'))
  throw new Error('A private session bus is required.');
const home = process.env.HOME;
const bus = process.env.DBUS_SESSION_BUS_ADDRESS;
const childEnvironment = () => testEnvironment(home, {}, bus);

function command(file: string, args: string[], input = '') {
  return new Promise<{ status: number; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn(file, args, {
        env: childEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', () =>
        resolve({ status: 1, stdout: '', stderr: 'Process unavailable' }),
      );
      child.on('close', (status) =>
        resolve({ status: status ?? 1, stdout, stderr }),
      );
      child.stdin.end(input);
    },
  );
}
let daemon: ChildProcessWithoutNullStreams | undefined;
if (process.env.NOOK_TEST_SERVICE !== 'absent') {
  daemon = spawn(
    '/usr/bin/gnome-keyring-daemon',
    ['--unlock', '--components=secrets', '--foreground'],
    { env: childEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const startingDaemon = daemon;
  startingDaemon.stderr.resume();
  await new Promise<void>((accept, reject) => {
    const failed = () => {
      clearTimeout(timeout);
      reject(new Error('Private keyring could not initialize.'));
    };
    const timeout = setTimeout(failed, 10_000);
    startingDaemon.on('error', failed);
    startingDaemon.on('exit', failed);
    startingDaemon.stdin.on('error', failed);
    // GNOME closes stdout after initialization. Its background launcher exits earlier.
    startingDaemon.stdout.once('end', () => {
      clearTimeout(timeout);
      accept();
    });
    startingDaemon.stdout.resume();
    startingDaemon.stdin.end('synthetic-keyring-password\n');
  });
  const stored = await command(
    '/usr/bin/secret-tool',
    ['store', '--label=Nook test readiness', 'service', 'nook-test-readiness'],
    'synthetic-probe',
  );
  if (stored.status !== 0)
    throw new Error('Private Secret Service unavailable.');
  const probe = await command('/usr/bin/secret-tool', [
    'lookup',
    'service',
    'nook-test-readiness',
  ]);
  if (probe.stdout.trim() !== 'synthetic-probe')
    throw new Error('Private keyring probe failed.');
  await command('/usr/bin/secret-tool', [
    'clear',
    'service',
    'nook-test-readiness',
  ]);
}
const send = (message: unknown) =>
  process.stdout.write(`${JSON.stringify(message)}\n`);
send({ ready: true, bus: process.env.DBUS_SESSION_BUS_ADDRESS });
const children = new Map<number, ReturnType<typeof spawn>>();
const reader = createInterface({ input: process.stdin });
reader.on('line', (line) => {
  const request = JSON.parse(line) as {
    id: number;
    file: string;
    args: string[];
    input?: string;
    cwd?: string;
    env?: Record<string, string>;
    unset?: string[];
    signal?: NodeJS.Signals;
  };
  if (request.signal) {
    children.get(request.id)?.kill(request.signal);
    return;
  }
  const overrides: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(request.env ?? {}),
  );
  for (const name of request.unset ?? []) overrides[name] = undefined;
  const env = testEnvironment(home, overrides, bus);
  if (env.DBUS_SESSION_BUS_ADDRESS !== process.env.DBUS_SESSION_BUS_ADDRESS)
    throw new Error('A private session bus is required for every child.');
  const child = spawn(request.file, request.args, {
    env,
    cwd: request.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.set(request.id, child);
  child.stdout.on('data', (chunk) =>
    send({ id: request.id, stream: 'stdout', data: String(chunk) }),
  );
  child.stderr.on('data', (chunk) =>
    send({ id: request.id, stream: 'stderr', data: String(chunk) }),
  );
  child.on('error', () =>
    send({ id: request.id, stream: 'stderr', data: 'Process unavailable' }),
  );
  child.on('close', (status) => {
    children.delete(request.id);
    send({ id: request.id, status: status ?? 1 });
  });
  child.stdin.end(request.input ?? '');
});
reader.on('close', () => {
  daemon?.kill();
  for (const child of children.values()) child.kill();
});
