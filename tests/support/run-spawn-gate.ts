import children, { type SpawnOptions } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';

// Real launch held after the child starts, matching macOS registry inspection.
const original = children.spawn;
children.spawn = ((
  file: string,
  parameters?: readonly string[] | SpawnOptions,
  options?: SpawnOptions,
) => {
  const args = Array.isArray(parameters) ? parameters : [];
  const settings = Array.isArray(parameters)
    ? options
    : ((parameters as SpawnOptions | undefined) ?? options);
  if (!args.includes('startup-wait'))
    return original(file, args, settings ?? {});
  const home = process.env.HOME;
  if (!home) throw new Error('The launch gate requires a private HOME.');
  const child = original(file, args, { ...settings, detached: true });
  writeFileSync(resolve(home, 'spawn-held'), String(process.pid));
  const release = resolve(home, 'spawn-release');
  const deadline = Date.now() + 8000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(release) && Date.now() < deadline)
    Atomics.wait(wait, 0, 0, 100);
  writeFileSync(resolve(home, 'spawn-returned'), '');
  return child;
}) as typeof children.spawn;
syncBuiltinESMExports();
