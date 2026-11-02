import children, { type SpawnOptions } from 'node:child_process';
import fs, {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';

// Failure injection and launch observation run only in a private fixture HOME.
const original = children.spawn;
const observation = resolve(process.env.HOME ?? '', 'observe-lifecycle');
const configuration = existsSync(observation)
  ? JSON.parse(readFileSync(observation, 'utf8'))
  : {};
const writeSync = fs.writeSync;
const writeAsync = fs.write;
let flushToken: string | undefined;
function observeToken(fd: number, bytes: unknown) {
  if (
    !flushToken ||
    !(typeof bytes === 'string' || bytes instanceof Uint8Array) ||
    !Buffer.from(bytes).equals(Buffer.from(flushToken))
  )
    return false;
  appendFileSync(
    resolve(process.env.HOME ?? '', 'flush-tokens'),
    JSON.stringify({ fd, token: flushToken }) + '\n',
  );
  return true;
}
function tokenQueued() {
  const home = process.env.HOME ?? '';
  if (existsSync(resolve(home, 'relay-release')))
    writeFileSync(resolve(home, 'lifecycle-events'), 'token-queued\n');
}
fs.writeSync = ((...parameters: Parameters<typeof fs.writeSync>) => {
  const [fd, bytes] = parameters;
  const token = observeToken(fd, bytes);
  try {
    return writeSync(...parameters);
  } catch (error) {
    if (token && existsSync(resolve(process.env.HOME ?? '', 'relay-release')))
      writeFileSync(
        resolve(process.env.HOME ?? '', 'token-write-error'),
        (error as NodeJS.ErrnoException).code ?? 'unknown',
      );
    throw error;
  } finally {
    if (token) tokenQueued();
  }
}) as typeof fs.writeSync;
fs.write = ((...parameters: Parameters<typeof fs.write>) => {
  const token = observeToken(parameters[0], parameters[1]);
  const result = writeAsync(...parameters);
  if (token) tokenQueued();
  return result;
}) as typeof fs.write;
children.spawn = ((file: string, args: string[], options: SpawnOptions) => {
  const home = process.env.HOME;
  if (!home) throw new Error('The relay seam requires a private HOME.');
  if (!args.includes('--nook-output-relay')) {
    const child = original(file, args, options);
    if (
      args[1] === 'large' &&
      (configuration.backpressure ||
        configuration.pressure === 'nonblocking-output')
    ) {
      // Spawn can reset inherited stdio to blocking. Change the description
      // shared with the already-running relay after spawning the real child.
      // Gate that child so it cannot write before this flag change completes.
      const output = process.stdout as typeof process.stdout & {
        _handle: { setBlocking(blocking: boolean): void };
      };
      output._handle.setBlocking(false);
      writeFileSync(resolve(home, 'nonblocking-ready'), 'x');
    }
    return child;
  }
  if (existsSync(resolve(home, 'refuse-relay')))
    throw new Error('fixture-start-failure');
  const lifecycle = new URL('./run-relay-lifecycle.ts', import.meta.url);
  lifecycle.searchParams.set('home', home);
  const relayArgs = [
    `--import=${new URL('./run-relay-fs-only.ts', import.meta.url).href}`,
    ...(existsSync(resolve(home, 'observe-lifecycle'))
      ? [`--import=${lifecycle.href}`]
      : []),
    ...args,
  ];
  const child = original(
    existsSync(resolve(home, 'unavailable-relay'))
      ? '/nook-fixture-absent-relay'
      : file,
    relayArgs,
    options,
  );
  writeFileSync(
    resolve(home, 'relay-launch'),
    JSON.stringify({
      args: relayArgs,
      env: options.env,
      pid: child.pid,
      readers: Array.isArray(options.stdio) ? options.stdio.length - 4 : 0,
    }),
  );
  {
    const control = child.stdio[3];
    if (control && 'write' in control) {
      const write = control.write.bind(control);
      control.write = ((...parameters: Parameters<typeof control.write>) => {
        const message = JSON.parse(String(parameters[0])) as { token: string };
        flushToken = message.token;
        writeFileSync(resolve(home, 'flush-token'), flushToken);
        if (existsSync(resolve(home, 'break-protocol')))
          return write('invalid-json\n');
        return write(...parameters);
      }) as typeof control.write;
    }
  }
  if (existsSync(resolve(home, 'break-delivery'))) {
    const control = child.stdio[3];
    if (control && 'write' in control)
      control.write = () => {
        child.kill('SIGKILL');
        return false;
      };
  }
  return child;
}) as typeof children.spawn;
syncBuiltinESMExports();
