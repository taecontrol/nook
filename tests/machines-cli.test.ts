import { beforeEach, expect, it } from 'vitest';
import { createArgs } from './support/agent-create.ts';
import { approve, ownerRuntime } from './support/authorizations.ts';
import {
  type PrivateKeyring,
  privateKeyring,
  readUserCode,
} from './support/cli.ts';
import { listMachines, revokeMachine } from './support/machines.ts';
import { expectOutput } from './support/private-assertions.ts';
import { runtime, type TestRuntime } from './support/runtime.ts';
import { expectNoValue, secretInput } from './support/vault.ts';

let app: TestRuntime;
let keyring: PrivateKeyring;
beforeEach(async () => {
  app = await ownerRuntime(await runtime());
  keyring = await privateKeyring();
  return async () => {
    await keyring.close();
    await app.close();
  };
});
async function login() {
  const child = keyring.start(['login', app.origin]);
  const code = await readUserCode(child);
  expect((await approve(app, code, 'framework-13')).status).toBe(204);
  expect((await child.done).status).toBe(0);
}
it('E8: revoked CLI commands give a recovery sequence that obtains a new approval', async () => {
  const value = secretInput().value;
  await login();
  const token = await keyring.lookup(app.origin);
  const [machine] = await listMachines(app);
  expect((await revokeMachine(app, machine.id)).status).toBe(204);
  const commands = [
    { args: ['whoami'] },
    { args: ['vault', 'list', 'me'] },
    {
      args: [
        'run',
        '--secret',
        'GH_TOKEN=me/RECONNECT_TOKEN',
        '--purpose',
        'check reconnect guidance',
        '--',
        process.execPath,
        '-e',
        'process.exit(99)',
      ],
    },
    { args: createArgs(), input: value },
  ];
  for (const command of commands) {
    const result = await keyring.start(command.args, {}, command.input).done;
    expectNoValue(result.stdout + result.stderr, [value, token]);
    expect(result.status).toBe(1);
    expectOutput(
      result.stdout + result.stderr,
      `This machine's token is no longer valid. Run: nook logout && nook login ${app.origin}`,
      true,
    );
  }
  expect((await keyring.lookup(app.origin)) === token).toBe(true);

  // Execute the two commands in the printed sequence, approving the new login.
  expect((await keyring.start(['logout']).done).status).toBe(0);
  expect((await keyring.lookup(app.origin)) === '').toBe(true);
  await login();
  const [replacement] = await listMachines(app);
  expect(replacement.id === machine.id).toBe(false);
  expect((await keyring.lookup(app.origin)) === token).toBe(false);
  const identity = await keyring.start(['whoami']).done;
  expect(identity.status).toBe(0);
  expectNoValue(identity.stdout + identity.stderr, [token]);
});
