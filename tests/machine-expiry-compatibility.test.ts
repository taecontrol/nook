import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  machinePaths,
  machineRequest,
  setExpiry,
} from './support/access-expiry.ts';
import {
  previousMachineBuild,
  previousMachineWorker,
} from './support/access-expiry-previous.ts';
import {
  approve,
  createAuthorization,
  issueToken,
  jsonRequest,
} from './support/authorizations.ts';
import {
  listMachines,
  machineIdentity,
  revokeMachine,
  tokenSnapshot,
} from './support/machines.ts';

let base: Awaited<ReturnType<typeof previousMachineBuild>>;
beforeAll(async () => {
  base = await previousMachineBuild();
});
afterAll(async () => {
  await base?.close();
});
it('Expiry E17: the delivery-base Worker rejects expired tokens with its exact body, lists and revokes them, and old approvals polled after upgrade never expire', async () => {
  const app = await previousMachineWorker(base.directory);
  try {
    const issued = await issueToken(app);
    await setExpiry(app, issued.token, -86_400_000);
    const before = await tokenSnapshot(app);
    for (const route of machinePaths('synthetic-unusable-value')) {
      const response = await machineRequest(app, issued.token, route);
      expect(response.status, route.name).toBe(401);
      expect(await response.text(), route.name).toBe('{"_tag":"Unauthorized"}');
      expect(await tokenSnapshot(app)).toBe(before);
    }
    const [expired] = await listMachines(app);
    expect((await revokeMachine(app, expired.id)).status).toBe(204);
    expect(await listMachines(app)).toEqual([]);
    const pending = await createAuthorization(app);
    expect((await approve(app, pending.userCode)).status).toBe(204);
    await app.upgrade();
    const poll = await jsonRequest(app, '/api/machine/token', {
      deviceCode: pending.deviceCode,
    });
    expect(poll.status).toBe(200);
    const body = (await poll.json()) as { token: string };
    expect(Object.keys(body).sort()).toEqual(['grant', 'machine', 'token']);
    const identity = await machineIdentity(app, body.token);
    expect(identity.status).toBe(200);
    expect(await identity.json()).toHaveProperty('expiresAt', null);
  } finally {
    await app.close();
  }
});
