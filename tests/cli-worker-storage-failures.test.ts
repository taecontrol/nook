import { beforeEach, expect, it } from 'vitest';
import {
  approve,
  createAuthorization,
  issueToken,
  jsonRequest,
  ownerRuntime,
} from './support/authorizations.ts';
import { responseHasTag } from './support/private-assertions.ts';
import { runtime, type TestRuntime } from './support/runtime.ts';

let app: TestRuntime;
beforeEach(async () => {
  app = await ownerRuntime(await runtime());
  return () => app.close();
});
it('failed exchange deletion rolls back issuance and a retry redeems once', async () => {
  const pending = await createAuthorization(app);
  expect((await approve(app, pending.userCode)).status).toBe(204);
  const db = await app.mf.getD1Database('DB');
  await db
    .prepare(
      "CREATE TRIGGER synthetic_fail_delete BEFORE DELETE ON authorizations BEGIN SELECT RAISE(ABORT, 'Synthetic storage failure'); END",
    )
    .run();
  const failed = await jsonRequest(app, '/api/machine/token', {
    deviceCode: pending.deviceCode,
  });
  expect(failed.status).toBe(503);
  expect(await responseHasTag(failed, 'ServiceUnavailable', false)).toBe(true);
  expect(
    (await db.prepare('SELECT count(*) AS count FROM machine_tokens').first())
      ?.count,
  ).toBe(0);
  expect(
    (await db.prepare('SELECT status FROM authorizations').first())?.status,
  ).toBe('approved');
  await db.prepare('DROP TRIGGER synthetic_fail_delete').run();
  const retry = await jsonRequest(app, '/api/machine/token', {
    deviceCode: pending.deviceCode,
  });
  expect(retry.status).toBe(200);
  expect(
    (await db.prepare('SELECT count(*) AS count FROM authorizations').first())
      ?.count,
  ).toBe(0);
  expect(
    (await db.prepare('SELECT count(*) AS count FROM machine_tokens').first())
      ?.count,
  ).toBe(1);
  expect(
    await responseHasTag(
      await jsonRequest(app, '/api/machine/token', {
        deviceCode: pending.deviceCode,
      }),
      'invalid',
    ),
  ).toBe(true);
});
it('failed owner update leaves the request pending and retry succeeds', async () => {
  const pending = await createAuthorization(app);
  const db = await app.mf.getD1Database('DB');
  await db
    .prepare(
      "CREATE TRIGGER synthetic_fail_update BEFORE UPDATE ON authorizations BEGIN SELECT RAISE(ABORT, 'Synthetic storage failure'); END",
    )
    .run();
  const failed = await approve(app, pending.userCode);
  expect(failed.status).toBe(503);
  expect(await responseHasTag(failed, 'ServiceUnavailable', false)).toBe(true);
  expect(
    (await db.prepare('SELECT status FROM authorizations').first())?.status,
  ).toBe('pending');
  await db.prepare('DROP TRIGGER synthetic_fail_update').run();
  expect((await approve(app, pending.userCode)).status).toBe(204);
});
it('failed creation rolls back cleanup and retries without leaking a partial request', async () => {
  await createAuthorization(app);
  const db = await app.mf.getD1Database('DB');
  await db.prepare('UPDATE authorizations SET expires_at=0').run();
  await db
    .prepare(
      "CREATE TRIGGER synthetic_fail_insert BEFORE INSERT ON authorizations BEGIN SELECT RAISE(ABORT, 'Synthetic storage failure'); END",
    )
    .run();
  const failed = await jsonRequest(app, '/api/machine/authorizations', {
    suggestedName: 'retry-machine',
    client: 'nook test',
  });
  expect(failed.status).toBe(503);
  expect(await responseHasTag(failed, 'ServiceUnavailable', false)).toBe(true);
  expect(
    (await db.prepare('SELECT count(*) AS count FROM authorizations').first())
      ?.count,
  ).toBe(1);
  await db.prepare('DROP TRIGGER synthetic_fail_insert').run();
  await createAuthorization(app);
  expect(
    (await db.prepare('SELECT count(*) AS count FROM authorizations').first())
      ?.count,
  ).toBe(1);
});
it('failed revocation preserves identity and permits retry', async () => {
  const issued = await issueToken(app);
  const db = await app.mf.getD1Database('DB');
  await db
    .prepare(
      "CREATE TRIGGER synthetic_fail_revoke BEFORE DELETE ON machine_tokens BEGIN SELECT RAISE(ABORT, 'Synthetic storage failure'); END",
    )
    .run();
  const headers = { Authorization: `Bearer ${issued.token}` };
  const failed = await fetch(`${app.origin}/api/machine/token`, {
    method: 'DELETE',
    headers,
  });
  expect(failed.status).toBe(503);
  expect(await responseHasTag(failed, 'ServiceUnavailable', false)).toBe(true);
  expect(
    (await fetch(`${app.origin}/api/machine/whoami`, { headers })).status,
  ).toBe(200);
  await db.prepare('DROP TRIGGER synthetic_fail_revoke').run();
  expect(
    (
      await fetch(`${app.origin}/api/machine/token`, {
        method: 'DELETE',
        headers,
      })
    ).status,
  ).toBe(204);
  expect(
    (await fetch(`${app.origin}/api/machine/whoami`, { headers })).status,
  ).toBe(401);
});
