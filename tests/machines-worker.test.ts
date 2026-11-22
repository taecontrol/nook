import { createInterface } from 'node:readline';
import { Log, LogLevel } from 'miniflare';
import { beforeEach, expect, it } from 'vitest';
import { access, accessFixture } from './support/access.ts';
import {
  createAuthorization,
  issueToken,
  ownerRuntime,
} from './support/authorizations.ts';
import { checkpointRuntime } from './support/checkpoint-runtime.ts';
import {
  expectPrivate,
  listMachines,
  machineIdentity,
  revokeMachine,
  tokenHash,
  tokenSnapshot,
} from './support/machines.ts';
import { responseHasTag } from './support/private-assertions.ts';
import { runtime, type TestRuntime } from './support/runtime.ts';

let app: TestRuntime;
class PrivateLog extends Log {
  messages: string[] = [];
  constructor() {
    super(LogLevel.VERBOSE);
  }
  protected log(message: string) {
    this.messages.push(message);
  }
}
beforeEach(async () => {
  app = await ownerRuntime(await runtime());
  return () => app.close();
});
it('E1: the owner lists all active approvals with independent opaque ids, including duplicate names', async () => {
  for (const name of ['framework-13', 'framework-13', 'hetzner-vps'])
    await issueToken(app, name);
  await createAuthorization(app, 'not-approved');
  const machines = await listMachines(app);
  expect(machines.map((machine) => machine.name).sort()).toEqual([
    'framework-13',
    'framework-13',
    'hetzner-vps',
  ]);
  expect(new Set(machines.map((machine) => machine.id)).size).toBe(3);
  for (const machine of machines) {
    expect(typeof machine.id === 'string' && machine.id.length >= 16).toBe(
      true,
    );
    expect(Object.keys(machine).sort()).toEqual([
      'approvedAt',
      'expiresAt',
      'grant',
      'id',
      'lastUsedAt',
      'name',
    ]);
    expect(new Date(machine.approvedAt).toISOString()).toBe(machine.approvedAt);
    expect(machine.lastUsedAt).toBeNull();
    expect(machine.grant).toBe('all');
  }
});
it('E2: the list and every public id reveal neither tokens nor their hashes', async () => {
  const issued = await issueToken(app);
  const hash = await tokenHash(app, issued.token);
  const response = await fetch(`${app.origin}/api/machines`);
  expect(response.status).toBe(200);
  const text = await response.text();
  expectPrivate(text, [issued.token, hash]);
  expect(/token_hash|"token"/.test(text)).toBe(false);
  const { machines } = JSON.parse(text) as { machines: { id: string }[] };
  expectPrivate(machines.map((machine) => machine.id).join(','), [
    issued.token,
    hash,
  ]);
});
it('E4/E5: each authentication advances last use within its request interval; malformed, unknown, and revoked Bearers update none', async () => {
  const active = await issueToken(app, 'kept');
  const gone = await issueToken(app, 'gone');
  const machines = await listMachines(app);
  expect(
    (
      await revokeMachine(
        app,
        machines.find((machine) => machine.name === 'gone')!.id,
      )
    ).status,
  ).toBe(204);
  const before = await tokenSnapshot(app);
  for (const token of ['malformed', `nook_${'z'.repeat(43)}`, gone.token])
    expect((await machineIdentity(app, token)).status).toBe(401);
  expect(
    (await tokenSnapshot(app)) === before,
    'Denied credentials change no stored row',
  ).toBe(true);
  let previous = 0;
  for (let call = 0; call < 2; call++) {
    const before = Date.now();
    expect((await machineIdentity(app, active.token)).status).toBe(200);
    const after = Date.now();
    const at = Date.parse((await listMachines(app))[0].lastUsedAt ?? '');
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
    expect(at).toBeGreaterThan(previous);
    previous = at;
  }
});
it('E9: revoking one duplicate name preserves the other token and approval', async () => {
  const first = await issueToken(app, 'framework-13');
  const second = await issueToken(app, 'framework-13');
  const machines = await listMachines(app);
  const db = await app.mf.getD1Database('DB');
  const hash = await tokenHash(app, first.token);
  const target = await db
    .prepare('SELECT id FROM machine_tokens WHERE token_hash=?')
    .bind(hash)
    .first<{ id: string }>();
  expect((await revokeMachine(app, target!.id)).status).toBe(204);
  const remaining = await listMachines(app);
  expect(remaining).toHaveLength(1);
  expect(remaining[0].id).toBe(
    machines.find((machine) => machine.id !== target!.id)!.id,
  );
  expect((await machineIdentity(app, first.token)).status).toBe(401);
  expect((await machineIdentity(app, second.token)).status).toBe(200);
});
it('E10: repeated revocation, logout, and invented ids are idempotent and preserve other rows', async () => {
  const issued = await issueToken(app, 'logged-out');
  await issueToken(app, 'kept');
  const machines = await listMachines(app);
  const id = machines.find((machine) => machine.name === 'logged-out')!.id;
  expect(
    (
      await fetch(`${app.origin}/api/machine/token`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${issued.token}` },
      })
    ).status,
  ).toBe(204);
  const before = await tokenSnapshot(app);
  for (const target of [id, 'never-existed', "' OR 1=1 --"]) {
    expect((await revokeMachine(app, target)).status).toBe(204);
    expect(
      (await tokenSnapshot(app)) === before,
      'Idempotent revocation changes no unrelated row',
    ).toBe(true);
  }
  const [kept] = await listMachines(app);
  expect((await revokeMachine(app, kept.id)).status).toBe(204);
  expect((await revokeMachine(app, kept.id)).status).toBe(204);
  expect(await listMachines(app)).toEqual([]);
});
it('E11/E12/E13: owner routes require Access for the owner, refuse Nook Bearers and foreign-Origin revokes, and preserve every credential', async () => {
  const issued = await issueToken(app);
  const [machine] = await listMachines(app);
  const issuer = await accessFixture();
  // Keep the same populated database while enabling the genuine Access verifier.
  await app.setBindings(access, { outboundService: issuer.outboundService });
  const other = await issuer.assertion({ email: 'other@nook.test' });
  const owner = { 'Cf-Access-Jwt-Assertion': await issuer.assertion() };
  const before = await tokenSnapshot(app);
  for (const [headers, status] of [
    [{}, 401],
    [{ Authorization: `Bearer ${issued.token}` }, 401],
    [{ 'Cf-Access-Jwt-Assertion': other }, 403],
  ] as const) {
    expect(
      (await fetch(`${app.origin}/api/machines`, { headers })).status,
    ).toBe(status);
    expect((await revokeMachine(app, machine.id, headers)).status).toBe(status);
    expect((await tokenSnapshot(app)) === before).toBe(true);
  }
  expect(
    (
      await revokeMachine(app, machine.id, {
        ...owner,
        Origin: 'https://foreign.nook.test',
      })
    ).status,
  ).toBe(403);
  expect((await tokenSnapshot(app)) === before).toBe(true);
  expect((await machineIdentity(app, issued.token)).status).toBe(200);
  expect(await listMachines(app, owner)).toHaveLength(1);
  expect(
    (await revokeMachine(app, machine.id, { ...owner, Origin: app.origin }))
      .status,
  ).toBe(204);
});
it('E15: the machine bypass never exposes another machine list or revocation', async () => {
  const issued = await issueToken(app);
  const before = await tokenSnapshot(app);
  for (const headers of [
    {},
    { Authorization: `Bearer ${issued.token}` },
  ] as HeadersInit[]) {
    for (const [method, path] of [
      ['GET', '/api/machine/machines'],
      ['DELETE', '/api/machine/machines/other'],
    ] as const) {
      expect(
        (await fetch(`${app.origin}${path}`, { method, headers })).status,
      ).toBe(404);
    }
  }
  expect((await tokenSnapshot(app)) === before).toBe(true);
});
it.each(['GET', 'DELETE', 'authenticate'])(
  'E16: D1 failures in %s stay sanitized and preserve credentials',
  async (operation) => {
    const log = new PrivateLog();
    await app.setBindings(
      { LOCAL_OWNER: 'synthetic-owner', LOCAL_ORIGIN: app.origin },
      {
        log,
        handleRuntimeStdio: (stdout, stderr) => {
          for (const input of [stdout, stderr])
            createInterface({ input }).on('line', (message) => {
              log.messages.push(message);
            });
        },
      },
    );
    const issued = await issueToken(app);
    const hash = await tokenHash(app, issued.token);
    const [machine] = await listMachines(app);
    const db = await app.mf.getD1Database('DB');
    const before = await tokenSnapshot(app);
    if (operation === 'GET')
      await db
        .prepare(
          'ALTER TABLE machine_tokens RENAME TO unavailable_machine_tokens',
        )
        .run();
    else
      await db
        .prepare(
          `CREATE TRIGGER machine_failure BEFORE ${operation === 'DELETE' ? 'DELETE' : 'UPDATE'} ON machine_tokens BEGIN SELECT RAISE(ABORT, '${hash}'); END`,
        )
        .run();
    const response =
      operation === 'GET'
        ? await fetch(`${app.origin}/api/machines`)
        : operation === 'DELETE'
          ? await revokeMachine(app, machine.id)
          : await machineIdentity(app, issued.token);
    expect(response.status).toBe(503);
    expectPrivate(await response.clone().text(), [issued.token, hash]);
    expectPrivate(log.messages.join('\n'), [issued.token, hash]);
    expect(await responseHasTag(response, 'ServiceUnavailable')).toBe(true);
    if (operation === 'GET')
      await db
        .prepare(
          'ALTER TABLE unavailable_machine_tokens RENAME TO machine_tokens',
        )
        .run();
    else await db.prepare('DROP TRIGGER machine_failure').run();
    expect((await tokenSnapshot(app)) === before).toBe(true);
    expect((await machineIdentity(app, issued.token)).status).toBe(200);
    expectPrivate(log.messages.join('\n'), [issued.token, hash]);
  },
);
it('E1/E4/E7: listing is one D1 statement, authentication plus last use is one statement, and revoke is one batch', async () => {
  const labels: string[] = [];
  const measured = await ownerRuntime(
    await checkpointRuntime(async (label) => {
      labels.push(label);
    }),
  );
  try {
    const issued = await issueToken(measured);
    labels.length = 0;
    const [machine] = await listMachines(measured);
    expect(labels).toEqual(['/machine-read']);
    labels.length = 0;
    expect((await machineIdentity(measured, issued.token)).status).toBe(200);
    expect(labels).toEqual(['/machine-write']);
    expect((await listMachines(measured))[0].lastUsedAt).not.toBeNull();
    labels.length = 0;
    expect((await revokeMachine(measured, machine.id)).status).toBe(204);
    expect(labels).toEqual([
      '/machine-before-batch',
      '/machine-batch',
      '/machine-write',
    ]);
  } finally {
    await measured.close();
  }
});
