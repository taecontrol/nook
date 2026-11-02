import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect } from 'vitest';
import {
  app,
  keyring,
  setupAgentCreateCli,
  token,
  transcript,
} from './agent-create-cli.ts';
import { auditRows } from './audit.ts';
import { filesContain } from './cli.ts';
import { machineMcp } from './grants.ts';
import type { CommandResult } from './macos-keychain.ts';
import { expectNoValue } from './vault.ts';

let values: string[];
let files: Map<string, Buffer>;
let outputs: string[];
export const importArgs = (bucket = 'work/acme', file = '.env') => [
  'vault',
  'import',
  bucket,
  file,
  '--purpose',
  'migrate acme env',
];
export function privateValue() {
  const value = `synthetic-${randomUUID()}-${randomUUID()}`;
  values.push(value);
  return value;
}
export async function envFile(content: string | Buffer, file = '.env') {
  const bytes = Buffer.from(content);
  const path = resolve(keyring.home, 'source', file);
  await writeFile(path, bytes);
  files.set(path, bytes);
  return path;
}
export function record(result: CommandResult) {
  outputs.push(result.stdout, result.stderr);
  return result;
}
export async function importFile(
  args = importArgs(),
  env: Record<string, string> = {},
) {
  return record(
    await keyring.start(
      args,
      { ...observeArgv(), ...env },
      '',
      resolve(keyring.home, 'source'),
    ).done,
  );
}
export function setupImportCli() {
  setupAgentCreateCli();
  beforeEach(async () => {
    values = [];
    files = new Map();
    outputs = [];
    await mkdir(resolve(keyring.home, 'source'));
    // Observe actual argv as well as the keyring command transcript on both OSes.
    await writeFile(
      resolve(keyring.home, 'observe.mjs'),
      `
      import { appendFileSync } from 'node:fs';
      appendFileSync(process.env.HOME + '/cli-argv', JSON.stringify(process.argv) + '\\n');
    `,
    );
  });
  afterEach(async () => {
    const source = resolve(keyring.home, 'source');
    for (const [path, bytes] of files)
      expect(
        (await readFile(path)).equals(bytes),
        'The source file stays byte-identical',
      ).toBe(true);
    // Check source additions too, then exclude only the original input files.
    for (const name of await readdir(source)) {
      const path = resolve(source, name);
      if (files.has(path)) await rm(path);
    }
    const discovery = await machineMcp(app, token).call('list_secrets', {
      bucket: 'work/acme',
    });
    const argv = await readFile(
      resolve(keyring.home, 'cli-argv'),
      'utf8',
    ).catch(() => '');
    const privateParts = [...values, token, app.key].flatMap((value) => [
      value,
      value.slice(0, 18),
      value.slice(-18),
    ]);
    expectNoValue(
      outputs.join('\n') +
        argv +
        (await transcript()) +
        JSON.stringify(await auditRows(app)) +
        JSON.stringify(discovery),
      privateParts,
    );
    for (const value of privateParts)
      expect(
        await filesContain(keyring.home, value),
        'No plaintext is written by the CLI',
      ).toBe(false);
  });
}
export function observeArgv() {
  return { NODE_OPTIONS: `--import=${resolve(keyring.home, 'observe.mjs')}` };
}
