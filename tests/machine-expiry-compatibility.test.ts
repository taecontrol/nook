import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  applyMigrations,
  migrationFiles,
  verifyMigrations,
} from '../scripts/lib/migrations.ts';
import {
  expiryColumns,
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
it('Expiry E16: migration 0014 replays on empty, already-migrated and populated schemas and matches the snapshot', async () => {
  expect(await migrationFiles('migrations')).toContain(
    '0014_machine_access_expiry.sql',
  );
  expect(await verifyMigrations()).toMatchObject({
    replayed: true,
    upgraded: true,
    schemaMatches: true,
  });
});
it('Expiry E7/E16: migrating a populated previous schema preserves NULL expiry and its active token', async () => {
  const mf = new Miniflare({
    modules: true,
    cf: false,
    script: 'export default {fetch(){return new Response()}}',
    d1Databases: ['DB'],
    d1Persist: false,
  });
  try {
    const db = await mf.getD1Database('DB');
    const names = await migrationFiles('migrations');
    await applyMigrations(db, 'migrations', {
      only: names.filter((name) => name < '0014'),
    });
    await db
      .prepare(
        `INSERT INTO machine_tokens(token_hash, machine_name, grant_json, created_at) VALUES ('old-hash', 'old-machine', '"all"', 0)`,
      )
      .run();
    await applyMigrations(db);
    await expiryColumns(db);
    expect(
      await db
        .prepare('SELECT access_expires_at, last_used_at FROM machine_tokens')
        .first(),
    ).toEqual({ access_expires_at: null, last_used_at: null });
    expect(
      (
        await db
          .prepare(
            "UPDATE machine_tokens SET last_used_at=unixepoch('subsec')*1000 WHERE token_hash='old-hash' RETURNING id",
          )
          .all()
      ).results,
    ).toHaveLength(1);
  } finally {
    await mf.dispose();
  }
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
