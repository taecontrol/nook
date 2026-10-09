import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeEach, expect, it } from 'vitest';
import {
  type PrivateKeyring,
  privateKeyring,
  readUserCode,
} from './support/cli.ts';
import { approveGrant } from './support/grants.ts';
import { listMachines, revokeMachine } from './support/machines.ts';
import { expectOutput } from './support/private-assertions.ts';
import {
  expectNoValue,
  seedSecrets,
  vaultRuntime,
  visibleAcme,
} from './support/vault.ts';

let app: Awaited<ReturnType<typeof vaultRuntime>>;
let keyring: PrivateKeyring;
beforeEach(async () => {
  app = await vaultRuntime();
  keyring = await privateKeyring();
  return async () => {
    await keyring.close();
    await app.close();
  };
});
async function login(grant: 'all' | string[] = ['work/acme']) {
  const child = keyring.start(['login', app.origin]);
  const code = await readUserCode(child);
  expect((await approveGrant(app, code, grant)).status).toBe(204);
  expect((await child.done).status).toBe(0);
}
it('E17: real nook vault list emits only ordered paths and optional descriptions', async () => {
  const values = await seedSecrets(app);
  await login();
  const result = await keyring.start(['vault', 'list', 'work/acme']).done;
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  const descriptions = [
    'Staging Postgres connection string',
    'Fine-grained token for acme repositories',
    '',
    'Stripe test-mode secret key',
    'Publish token for the work npm org',
    'Personal access token for gh',
    '',
  ];
  expectOutput(
    result.stdout,
    visibleAcme
      .map((path, i) =>
        descriptions[i] ? `${path}  ${descriptions[i]}` : path,
      )
      .join('\n'),
    true,
  );
  expectNoValue(result.stdout + result.stderr, [
    ...values,
    await keyring.lookup(app.origin),
  ]);
});
it('E18: real CLI denial, missing bucket and usage each emit one line and exit one', async () => {
  await login();
  for (const [args, message] of [
    [['vault', 'list', 'personal'], 'Access to this bucket is forbidden.'],
    [['vault', 'list', 'work/acme/missing'], 'Bucket not found.'],
    [['vault', 'list'], 'Usage: nook vault list <bucket>'],
    [['vault', 'list', 'Work/Acme'], 'Use lowercase letters: work/acme'],
  ] as const) {
    const result = await keyring.start([...args]).done;
    expect(result.status).toBe(1);
    expectOutput(result.stdout + result.stderr, message, true);
  }
});
it('Vault parser failures end with command-specific usage', async () => {
  const result = await keyring.start(['vault', 'unknown']).done;
  expect(result.status).toBe(1);
  expectOutput(
    (result.stdout + result.stderr).trimEnd().split('\n').at(-1) ?? '',
    'Usage: nook vault list <bucket>',
    true,
  );
});
it('Vault list uses the existing unavailable-server guidance for a genuine storage failure', async () => {
  await login();
  await (await app.mf.getD1Database('DB'))
    .prepare('ALTER TABLE secrets RENAME TO unavailable_secrets')
    .run();
  const result = await keyring.start(['vault', 'list', 'work/acme']).done;
  expect(result.status).toBe(1);
  expectOutput(
    result.stdout + result.stderr,
    `Could not reach ${app.origin}. Try again.`,
    true,
  );
  expectNoValue(result.stdout + result.stderr, [
    await keyring.lookup(app.origin),
  ]);
});
it('E18: revoked and absent sessions use existing reconnect guidance', async () => {
  let result = await keyring.start(['vault', 'list', 'me']).done;
  expect(result.status).toBe(1);
  expectOutput(
    result.stdout + result.stderr,
    'Not logged in. Run: nook login <your Nook URL>',
    true,
  );
  await login();
  const [machine] = await listMachines(app);
  expect((await revokeMachine(app, machine.id)).status).toBe(204);
  result = await keyring.start(['vault', 'list', 'work/acme']).done;
  expect(result.status).toBe(1);
  expectOutput(
    result.stdout + result.stderr,
    `This machine's token is no longer valid. Run: nook logout && nook login ${app.origin}`,
    true,
  );
});
it('E18: an empty bucket lists ancestors and a fresh installation has clear empty feedback', async () => {
  await login('all');
  const fresh = await keyring.start(['vault', 'list', 'me']).done;
  expect(fresh.status).toBe(0);
  expectOutput(fresh.stdout, 'No secrets visible from me.', true);
  await seedSecrets(app);
  const empty = await keyring.start(['vault', 'list', 'work/globex']).done;
  expect(empty.status).toBe(0);
  expectOutput(
    empty.stdout,
    'work/NPM_TOKEN  Publish token for the work npm org\nme/GITHUB_TOKEN  Personal access token for gh\nme/OPENAI_API_KEY',
    true,
  );
  const token = await keyring.lookup(app.origin);
  expectNoValue(empty.stdout + empty.stderr, [token]);
  expect(
    (await readFile(resolve(keyring.home, 'argv'), 'utf8')).includes(token),
  ).toBe(false);
});
