import { beforeEach, expect, it } from 'vitest';
import { approve, ownerRuntime } from './support/authorizations.ts';
import {
  type PrivateKeyring,
  privateKeyring,
  readUserCode,
} from './support/cli.ts';
import { listMachines, revokeMachine } from './support/machines.ts';
import { expectOutput } from './support/private-assertions.ts';
import { runtime, type TestRuntime } from './support/runtime.ts';

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
it('E4: each real CLI whoami advances last use within the observed request interval', async () => {
  await login();
  let previous = 0;
  for (let call = 0; call < 2; call++) {
    const before = Date.now();
    expect((await keyring.start(['whoami']).done).status).toBe(0);
    const after = Date.now();
    const [machine] = await listMachines(app);
    expect(machine.lastUsedAt).not.toBeNull();
    const at = Date.parse(machine.lastUsedAt!);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
    expect(at).toBeGreaterThan(previous);
    previous = at;
  }
});
it('E6: real CLI logout removes the machine from the owner list and private keyring', async () => {
  await login();
  expect(await listMachines(app)).toHaveLength(1);
  expect((await keyring.start(['logout']).done).status).toBe(0);
  expect(await listMachines(app)).toEqual([]);
  expect(
    (await keyring.lookup(app.origin)) === '',
    'Logout clears the private credential',
  ).toBe(true);
});
it('E8: real CLI whoami after owner revocation exits one with the exact reconnect guidance', async () => {
  await login();
  const [machine] = await listMachines(app);
  expect((await revokeMachine(app, machine.id)).status).toBe(204);
  const result = await keyring.start(['whoami']).done;
  expect(result.status).toBe(1);
  expectOutput(
    result.stdout + result.stderr,
    `This machine's token is no longer valid. Run: nook login ${app.origin}`,
    true,
  );
  // A stale credential can still be cleared through real CLI logout.
  expect((await keyring.start(['logout']).done).status).toBe(0);
  expect((await keyring.lookup(app.origin)) === '').toBe(true);
});
