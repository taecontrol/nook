import children, { type SpawnOptions } from 'node:child_process';
import fs, { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';

// Failure injection and launch observation run only in a private fixture HOME.
const original = children.spawn;
const writeSync = fs.writeSync;
let flushToken: string | undefined;
fs.writeSync = ((...parameters: Parameters<typeof fs.writeSync>) => {
  const [fd, bytes] = parameters;
  if (flushToken && Buffer.from(bytes).equals(Buffer.from(flushToken)))
    appendFileSync(
      resolve(process.env.HOME ?? '', 'flush-tokens'),
      JSON.stringify({ fd, token: flushToken }) + '\n',
    );
  return writeSync(...parameters);
}) as typeof fs.writeSync;
children.spawn = ((file: string, args: string[], options: SpawnOptions) => {
  const home = process.env.HOME;
  if (!home) throw new Error('The relay seam requires a private HOME.');
  if (!args.includes('--nook-output-relay'))
    return original(file, args, options);
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
