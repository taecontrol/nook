import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Log, LogLevel } from 'miniflare';
import { beforeEach, expect } from 'vitest';
import { acmePath, auditRows, runFixture } from './audit.ts';
import { privateKeyring } from './cli.ts';
import { expectOutput } from './private-assertions.ts';
import { createSecret, expectNoValue, secretInput } from './vault.ts';

export let app: Awaited<ReturnType<typeof runFixture>>;
export let keyring: Awaited<ReturnType<typeof privateKeyring>>;
export let project: string;
export let file: string;
export let checkpoints: string[];
export let privateValues: string[];
export let outputs: string[];
export let values: Record<string, string>;
export const childFile = resolve('tests/support/run-child.ts');
export const mappings = { GH_TOKEN: acmePath, DB_URL: 'work/acme/DB_URL' };
export const usage =
  'Usage: nook run --secret ENV=bucket/NAME --purpose "…" -- <command>';
class PrivateLog extends Log {
  messages: string[] = [];
  constructor() {
    super(LogLevel.VERBOSE);
  }
  protected log(message: string) {
    this.messages.push(message);
  }
}
export function expectPrivate(text: string) {
  expectNoValue(
    text,
    privateValues.flatMap((value) => [
      value,
      JSON.stringify(value).slice(1, -1),
    ]),
  );
}
export async function transcript() {
  return readFile(resolve(keyring.home, 'argv'), 'utf8').catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  });
}
export async function config(secrets: Record<string, unknown>, path = file) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ secrets }));
}
export async function cli(args: string[], cwd = project) {
  const result = await keyring.start(args, {}, '', cwd).done;
  outputs.push(result.stdout + result.stderr);
  expectPrivate(result.stdout + result.stderr);
  return result;
}
export function runArgs(command: string[], flags: string[] = []) {
  return [
    'run',
    ...flags.flatMap((entry) => ['--secret', entry]),
    '--purpose',
    'dev server',
    '--',
    ...command,
  ];
}
export function probe(entries: Record<string, string | undefined>, exit = 0) {
  return [
    process.execPath,
    childFile,
    'mappings',
    JSON.stringify(
      Object.entries(entries).map(([name, value]) => [
        name,
        value === undefined
          ? null
          : createHash('sha256').update(value).digest('hex'),
      ]),
    ),
    String(exit),
  ];
}
export const requests = (kind: 'value' | 'listing') =>
  checkpoints.filter((label) => label === `/${kind}-request`).length;
export async function auditPaths() {
  const rows = await auditRows(app);
  expectPrivate(JSON.stringify(rows));
  return rows.map((row) => String(row.path)).sort();
}
export async function beforeAccess(args: string[], message: string) {
  const before = await transcript();
  checkpoints.length = 0;
  const result = await cli(args);
  expect(result.status).toBe(1);
  expectOutput(result.stdout + result.stderr, message, true);
  expect((await transcript()) === before).toBe(true);
  expect(checkpoints).toEqual([]);
  expect(await auditPaths()).toEqual([]);
}
// Each test gets a fresh Worker, D1, keyring and project directory.
export function setupNookJsonCli() {
  beforeEach(async () => {
    checkpoints = [];
    outputs = [];
    app = await runFixture(['work/acme'], async (label) => {
      checkpoints.push(label);
      return true;
    });
    keyring = await privateKeyring();
    project = await realpath(keyring.home);
    project = resolve(project, 'project');
    file = resolve(project, 'nook.json');
    await mkdir(project);
    values = { GH_TOKEN: app.input.value };
    for (const name of ['DB_URL', 'OTHER', 'EXTRA', 'X']) {
      const input = secretInput({
        name,
        value: `\n${randomBytes(24).toString('base64')} 秘密\r\n\t `,
      });
      expect((await createSecret(app, input)).status).toBe(201);
      values[name] = input.value;
    }
    privateValues = [...Object.values(values), app.token, app.key];
    const log = new PrivateLog();
    const workerOutput = ['', ''];
    await app.setBindings(app.bindings, {
      log,
      handleRuntimeStdio: (stdout, stderr) => {
        [stdout, stderr].forEach((input, index) => {
          input.setEncoding('utf8');
          input.on('data', (chunk) => {
            workerOutput[index] += String(chunk);
          });
          createInterface({ input }).on('line', (line) =>
            log.messages.push(line),
          );
        });
      },
    });
    await mkdir(dirname(keyring.config), { recursive: true });
    await writeFile(keyring.config, JSON.stringify({ url: app.origin }));
    expect(await keyring.store(app.origin, app.token)).toBe(0);
    checkpoints.length = 0;
    return async () => {
      try {
        for (const text of [
          ...outputs,
          ...log.messages,
          ...workerOutput,
          JSON.stringify(await auditRows(app)),
          await transcript(),
        ])
          expectPrivate(text);
      } finally {
        await keyring.close();
        await app.close();
      }
    };
  });
}
