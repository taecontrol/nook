import { createInterface } from 'node:readline';
import { Log, LogLevel } from 'miniflare';
import { beforeEach, expect, it } from 'vitest';
import {
  d1Now,
  dayMs,
  lifetimes,
  machinePaths,
  machineRequest,
  setExpiry,
} from './support/access-expiry.ts';
import { auditRows } from './support/audit.ts';
import {
  createAuthorization,
  issueToken,
  jsonRequest,
} from './support/authorizations.ts';
import { issueGrant } from './support/grants.ts';
import {
  expectPrivate,
  listMachines,
  machineIdentity,
  revokeMachine,
  tokenHash,
  tokenSnapshot,
} from './support/machines.ts';
import type { TestRuntime } from './support/runtime.ts';
import {
  createSecret,
  expectNoValue,
  secretInput,
  vaultRuntime,
} from './support/vault.ts';

let app: TestRuntime;
beforeEach(async () => {
  app = await vaultRuntime();
  return () => app.close();
});
it.each(lifetimes)(
  'Expiry E2: %s starts on D1 approval time and poll keeps its released shape',
  async (lifetime, _label, duration) => {
    const pending = await createAuthorization(app);
    const before = await d1Now(app);
    expect(
      (
        await jsonRequest(
          app,
          `/api/authorizations/${pending.userCode}/approve`,
          { machineName: 'expiry-proof', grant: 'all', lifetime },
        )
      ).status,
    ).toBe(204);
    const after = await d1Now(app);
    const poll = await jsonRequest(app, '/api/machine/token', {
      deviceCode: pending.deviceCode,
    });
    expect(poll.status).toBe(200);
    const body = (await poll.json()) as { token: string };
    expect(Object.keys(body).sort()).toEqual(['grant', 'machine', 'token']);
    const identity = (await (
      await machineIdentity(app, body.token)
    ).json()) as { expiresAt?: string | null };
    if (duration === null) expect(identity.expiresAt).toBeNull();
    else {
      expect(typeof identity.expiresAt).toBe('string');
      expect(Date.parse(identity.expiresAt!)).toBeGreaterThanOrEqual(
        before + duration,
      );
      expect(Date.parse(identity.expiresAt!)).toBeLessThanOrEqual(
        after + duration,
      );
    }
    expect((await listMachines(app))[0]).toHaveProperty(
      'expiresAt',
      identity.expiresAt,
    );
  },
);
it('Expiry E3/E7: an old approval payload and existing credentials have no expiration', async () => {
  const issued = await issueToken(app);
  const response = await machineIdentity(app, issued.token);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    machine: 'synthetic-machine',
    grant: 'all',
    expiresAt: null,
  });
  expect((await listMachines(app))[0]).toHaveProperty('expiresAt', null);
});
it('Expiry E3: an unknown lifetime returns 400 before writing any authorization or token', async () => {
  const pending = await createAuthorization(app);
  const db = await app.mf.getD1Database('DB');
  const before = (await db.prepare('SELECT * FROM authorizations').all())
    .results;
  const tokens = await tokenSnapshot(app);
  const response = await jsonRequest(
    app,
    `/api/authorizations/${pending.userCode}/approve`,
    { machineName: 'must-stay-pending', grant: 'all', lifetime: '365d' },
  );
  expect(response.status).toBe(400);
  expect(
    (await db.prepare('SELECT * FROM authorizations').all()).results,
  ).toEqual(before);
  expect(await tokenSnapshot(app)).toBe(tokens);
});
class PrivateLog extends Log {
  messages: string[] = [];
  constructor() {
    super(LogLevel.VERBOSE);
  }
  protected log(message: string) {
    this.messages.push(message);
  }
}
it('Expiry E4/E18: every expired route rejects without last use, audit, credential or secret disclosure and retains the listed row', async () => {
  const input = secretInput({ name: 'GH_TOKEN' });
  expect((await createSecret(app, input)).status).toBe(201);
  const log = new PrivateLog();
  await app.setBindings(
    { LOCAL_OWNER: 'synthetic-owner', LOCAL_ORIGIN: app.origin },
    {
      log,
      handleRuntimeStdio: (stdout, stderr) => {
        for (const input of [stdout, stderr])
          createInterface({ input }).on('line', (message) =>
            log.messages.push(message),
          );
      },
    },
  );
  const issued = await issueToken(app);
  const hash = await tokenHash(app, issued.token);
  const expired = await setExpiry(app, issued.token, -dayMs);
  const before = await tokenSnapshot(app);
  const audit = await auditRows(app);
  for (const route of machinePaths(input.value)) {
    const response = await machineRequest(app, issued.token, route);
    const text = await response.text();
    expectPrivate(text, [issued.token, hash]);
    expectNoValue(text, [input.value]);
    expect(response.status, route.name).toBe(401);
    expect(text, route.name).toBe(
      JSON.stringify({
        _tag: 'Unauthorized',
        expiredAt: new Date(expired!).toISOString(),
      }),
    );
    expect(
      (await tokenSnapshot(app)) === before,
      `${route.name} preserves the token row`,
    ).toBe(true);
    expect(await auditRows(app), route.name).toEqual(audit);
  }
  expect(await listMachines(app)).toHaveLength(1);
  expectPrivate(log.messages.join('\n'), [issued.token, hash]);
  expectNoValue(
    log.messages.join('\n') + JSON.stringify(await auditRows(app)),
    [input.value],
  );
});
it('Expiry E5: unknown and revoked tokens keep the exact released 401 body on every route', async () => {
  const issued = await issueToken(app);
  await revokeMachine(app, (await listMachines(app))[0].id);
  for (const token of [`nook_${'z'.repeat(43)}`, issued.token]) {
    for (const route of machinePaths(secretInput().value)) {
      const response = await machineRequest(app, token, route);
      expect(response.status, route.name).toBe(401);
      expect(await response.text(), route.name).toBe('{"_tag":"Unauthorized"}');
    }
  }
});
it('Expiry E6: exactly D1 now is rejected, one millisecond before expiry is accepted, and a live dated token still denies another bucket', async () => {
  const { token } = await issueGrant(app, ['work/acme']);
  await setExpiry(app, token, dayMs);
  expect((await machineIdentity(app, token)).status).toBe(200);
  expect(
    (
      await fetch(
        `${app.origin}/api/machine/secrets?bucket=personal/finances`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
    ).status,
  ).toBe(403);
  const db = await app.mf.getD1Database('DB');
  // SQLite keeps 'now' stable throughout one step, including nested triggers.
  // Invoke the authenticating UPDATE in that step immediately after setting
  // expiry from the same D1 clock; no Worker or test clock grants access.
  await db.prepare('CREATE TABLE expiry_probe (delta INTEGER)').run();
  await db
    .prepare(`CREATE TRIGGER expiry_boundary AFTER INSERT ON expiry_probe BEGIN
    UPDATE machine_tokens SET access_expires_at=unixepoch('subsec')*1000+NEW.delta;
    UPDATE machine_tokens SET last_used_at=unixepoch('subsec')*1000;
  END`)
    .run();
  for (const delta of [0, 1]) {
    await setExpiry(app, token, null);
    await db.prepare('UPDATE machine_tokens SET last_used_at=0').run();
    await db.prepare('INSERT INTO expiry_probe VALUES (?)').bind(delta).run();
    const row = await db
      .prepare('SELECT last_used_at FROM machine_tokens')
      .first<{ last_used_at: number }>();
    expect(row!.last_used_at > 0, `D1 now + ${delta} ms`).toBe(delta === 1);
  }
});
