import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { dayMs, setExpiry } from './support/access-expiry.ts';
import {
  previousMachineBuild,
  previousMachineWorker,
} from './support/access-expiry-previous.ts';
import { createArgs } from './support/agent-create.ts';
import { issueToken } from './support/authorizations.ts';
import { type PrivateKeyring, privateKeyring } from './support/cli.ts';
import {
  listMachines,
  machineIdentity,
  revokeMachine,
} from './support/machines.ts';
import {
  configureFilesCli,
  fileTransport,
} from './support/memory-files-cli.ts';
import { expectOutput } from './support/private-assertions.ts';
import type { TestRuntime } from './support/runtime.ts';
import { expectNoValue, secretInput, vaultRuntime } from './support/vault.ts';

let app: TestRuntime;
let keyring: PrivateKeyring;
let token: string;
let base: Awaited<ReturnType<typeof previousMachineBuild>>;
beforeAll(async () => {
  base = await previousMachineBuild();
});
afterAll(async () => {
  await base?.close();
});
beforeEach(async () => {
  app = await vaultRuntime();
  keyring = await privateKeyring();
  token = (await issueToken(app)).token;
  await configureFilesCli(keyring, app.origin, token);
  return async () => {
    await keyring.close();
    await app.close();
  };
});
function localTime(iso: string) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Argentina/Buenos_Aires',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}
it('Expiry E8/E18: every authenticated CLI command reports the local expiration time, keeps its keyring token and emits no private values', async () => {
  const expired = await setExpiry(app, token, -dayMs);
  const input = secretInput().value;
  const file = resolve(keyring.home, 'proof.txt');
  await writeFile(file, 'synthetic-file');
  const commands = [
    { args: ['whoami'] },
    { args: ['vault', 'list', 'work/acme'] },
    { args: createArgs(), input },
    {
      args: [
        'run',
        '--secret',
        'GH_TOKEN=work/acme/GH_TOKEN',
        '--purpose',
        'expiry proof',
        '--',
        process.execPath,
        '-e',
        'process.exit(99)',
      ],
    },
    {
      args: ['memory', 'attach', '00000000-0000-4000-8000-000000000077', file],
    },
    {
      args: [
        'memory',
        'download',
        '00000000-0000-4000-8000-000000000077',
        'proof.txt',
        '--output',
        resolve(keyring.home, 'out.txt'),
      ],
    },
  ];
  for (const command of commands) {
    const result = await keyring.start(
      command.args,
      { TZ: 'America/Argentina/Buenos_Aires', LANG: 'en_US.UTF-8' },
      command.input,
    ).done;
    expect(result.status).toBe(1);
    expectOutput(
      result.stdout + result.stderr,
      `This machine's access expired on ${localTime(new Date(expired!).toISOString())}. Run: nook logout && nook login ${app.origin}`,
      true,
    );
    expectNoValue(result.stdout + result.stderr, [token, input]);
  }
  expect((await keyring.lookup(app.origin)) === token).toBe(true);
});
it('Expiry E8: a revoked token retains the released CLI recovery message', async () => {
  await revokeMachine(app, (await listMachines(app))[0].id);
  const result = await keyring.start(['whoami']).done;
  expect(result.status).toBe(1);
  expectOutput(
    result.stdout + result.stderr,
    `This machine's token is no longer valid. Run: nook logout && nook login ${app.origin}`,
    true,
  );
});
it.each([
  [30 * dayMs, 'in 30 days'],
  [5 * 3_600_000, 'in 5 hours'],
  [45 * 60_000, 'in 45 minutes'],
] as const)(
  'Expiry E9: whoami prints a local date and %s ms as %s',
  async (duration, relative) => {
    const expiry = await setExpiry(app, token, duration);
    const result = await keyring.start(['whoami'], {
      TZ: 'America/Argentina/Buenos_Aires',
      LANG: 'en_US.UTF-8',
    }).done;
    expect(result.status).toBe(0);
    expectOutput(
      result.stdout,
      `Expires: ${localTime(new Date(expiry!).toISOString())} (${relative})`,
    );
  },
);
it('Expiry E9: whoami prints never for NULL and omits the line against the actual previous Worker', async () => {
  const result = await keyring.start(['whoami']).done;
  expect(result.status).toBe(0);
  expectOutput(result.stdout, 'Expires: never');
  const old = await previousMachineWorker(base.directory);
  try {
    const issued = await issueToken(old);
    await configureFilesCli(keyring, old.origin, issued.token);
    const previous = await keyring.start(['whoami']).done;
    expect(previous.status).toBe(0);
    expect(previous.stdout).not.toContain('Expires:');
    expect((await machineIdentity(old, issued.token)).status).toBe(200);
  } finally {
    await old.close();
  }
});
it('Expiry E10: logout clears an expired credential with the usual message and keeps its owner row', async () => {
  await setExpiry(app, token, -dayMs);
  const before = await listMachines(app);
  const result = await keyring.start(['logout']).done;
  expect(result.status).toBe(0);
  expectOutput(
    result.stdout,
    `Logged out of ${app.origin}. The token was revoked and removed from the keyring.`,
    true,
  );
  expect((await keyring.lookup(app.origin)) === '').toBe(true);
  expect(await listMachines(app)).toEqual(before);
});
it('Expiry E11: the real delivery-base CLI decodes expired access as revoked and its logout clears the keyring', async () => {
  await setExpiry(app, token, -dayMs);
  const run = (args: string[]) =>
    keyring.command(process.execPath, [
      resolve(base.directory, 'cli.js'),
      ...args,
    ]).done;
  const result = await run(['whoami']);
  expect(result.status).toBe(1);
  expectOutput(
    result.stdout + result.stderr,
    `This machine's token is no longer valid. Run: nook logout && nook login ${app.origin}`,
    true,
  );
  expect(result.stdout + result.stderr).not.toContain('Could not reach');
  expect((await run(['logout'])).status).toBe(0);
  expect((await keyring.lookup(app.origin)) === '').toBe(true);
  expect(await listMachines(app)).toHaveLength(1);
});
it('Expiry E18: an expired file response carries no secret bytes through the real CLI transport', async () => {
  await setExpiry(app, token, -dayMs);
  const values: string[] = [];
  const proxy = await fileTransport(app, {
    after: async (response) => {
      values.push(await response.clone().text());
      return response;
    },
  });
  try {
    await mkdir(dirname(keyring.config), { recursive: true });
    await configureFilesCli(keyring, proxy.origin, token);
    const result = await keyring.start([
      'memory',
      'download',
      '00000000-0000-4000-8000-000000000077',
      'proof.txt',
      '--output',
      resolve(keyring.home, 'download.txt'),
    ]).done;
    expect(result.status).toBe(1);
    expectOutput(
      result.stdout + result.stderr,
      "This machine's access expired on",
    );
    expect(values).toHaveLength(1);
    expectNoValue(values.join('') + result.stdout + result.stderr, [token]);
  } finally {
    await proxy.close();
  }
});
