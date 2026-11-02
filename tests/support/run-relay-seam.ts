import children, { type SpawnOptions } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';

// Failure injection and launch observation run only in a private fixture HOME.
const original = children.spawn;
children.spawn = ((file: string, args: string[], options: SpawnOptions) => {
  const home = process.env.HOME!;
  if (!args.includes('--nook-output-relay'))
    return original(file, args, options);
  if (existsSync(resolve(home, 'refuse-relay')))
    throw new Error('fixture-start-failure');
  const child = original(file, args, options);
  writeFileSync(
    resolve(home, 'relay-launch'),
    JSON.stringify({ args, env: options.env, pid: child.pid }),
  );
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
