import { beforeEach, expect, it } from 'vitest';
import {
  approve,
  createAuthorization,
  jsonRequest,
  ownerRuntime,
} from './support/authorizations.ts';
import { checkpointRuntime } from './support/checkpoint-runtime.ts';
import { responseHasTag } from './support/private-assertions.ts';

let app: Awaited<ReturnType<typeof checkpointRuntime>>;
let held: string | undefined;
let releaseReads: (() => void)[];
let reads: number;
let batches: number;
beforeEach(async () => {
  held = undefined;
  releaseReads = [];
  reads = 0;
  batches = 0;
  app = await ownerRuntime(
    await checkpointRuntime(async (label) => {
      if (label.endsWith('-read')) reads++;
      if (label.endsWith('-batch') && !label.endsWith('-before-batch'))
        batches++;
      if (label === held)
        await new Promise<void>((release) => releaseReads.push(release));
    }),
  );
  return async () => {
    release();
    await app.close();
  };
});
function release() {
  held = undefined;
  for (const resume of releaseReads.splice(0)) resume();
}
async function waitFor(count = 1) {
  await expect.poll(() => releaseReads.length).toBe(count);
}
it('E16: owner actions with overlapping pending reads have exactly one winner', async () => {
  const pending = await createAuthorization(app);
  held = '/owner-read';
  const approval = approve(app, pending.userCode);
  const denial = jsonRequest(
    app,
    `/api/authorizations/${pending.userCode}/deny`,
  );
  await waitFor(2);
  release();
  const responses = await Promise.all([approval, denial]);
  expect(responses.map((response) => response.status).sort()).toEqual([
    204, 409,
  ]);
  expect(
    await responseHasTag(
      responses.find((response) => response.status === 409),
      'AlreadyHandled',
      false,
    ),
  ).toBe(true);
});
it('E15: polls with overlapping approved reads redeem one token', async () => {
  const pending = await createAuthorization(app);
  expect((await approve(app, pending.userCode)).status).toBe(204);
  held = '/poll-read';
  const polls = [0, 1].map(() =>
    jsonRequest(app, '/api/machine/token', { deviceCode: pending.deviceCode }),
  );
  await waitFor(2);
  release();
  const responses = await Promise.all(polls);
  expect(responses.map((response) => response.status).sort()).toEqual([
    200, 400,
  ]);
  expect(
    await responseHasTag(
      responses.find((response) => response.status === 400),
      'invalid',
    ),
  ).toBe(true);
});
it('E15: exchange remains atomic when both reads and writes overlap', async () => {
  const pending = await createAuthorization(app);
  expect((await approve(app, pending.userCode)).status).toBe(204);
  held = '/poll-read';
  const polls = [0, 1].map(() =>
    jsonRequest(app, '/api/machine/token', { deviceCode: pending.deviceCode }),
  );
  await waitFor(2);
  const readGates = releaseReads.splice(0);
  held = '/poll-write';
  for (const resume of readGates) resume();
  await waitFor(2);
  release();
  const responses = await Promise.all(polls);
  expect(responses.map((response) => response.status).sort()).toEqual([
    200, 400,
  ]);
  expect(
    await responseHasTag(
      responses.find((response) => response.status === 400),
      'invalid',
    ),
  ).toBe(true);
  expect(
    (
      await (
        await app.mf.getD1Database('DB')
      )
        .prepare('SELECT count(*) AS count FROM machine_tokens')
        .first()
    )?.count,
  ).toBe(1);
});
it.each(['approve', 'deny'] as const)(
  '%s cannot commit after the immutable deadline passes while D1 is delayed',
  async (action) => {
    const pending = await createAuthorization(app);
    const db = await app.mf.getD1Database('DB');
    const deadline = Date.now() + 1500;
    await db
      .prepare('UPDATE authorizations SET expires_at=?')
      .bind(deadline)
      .run();
    held = '/owner-before-batch';
    const response =
      action === 'approve'
        ? approve(app, pending.userCode)
        : jsonRequest(app, `/api/authorizations/${pending.userCode}/deny`);
    await waitFor();
    await expect
      .poll(() => Date.now() > deadline, { timeout: 5000 })
      .toBe(true);
    release();
    const result = await response;
    expect(result.status).toBe(410);
    expect(await responseHasTag(result, 'Expired', false)).toBe(true);
    expect(
      (await db.prepare('SELECT status FROM authorizations').first())?.status,
    ).toBe('pending');
  },
);
it('exchange cannot issue a token after the immutable deadline passes while D1 is delayed', async () => {
  const pending = await createAuthorization(app);
  expect((await approve(app, pending.userCode)).status).toBe(204);
  const db = await app.mf.getD1Database('DB');
  const deadline = Date.now() + 1500;
  await db
    .prepare('UPDATE authorizations SET expires_at=?')
    .bind(deadline)
    .run();
  held = '/poll-before-batch';
  const poll = jsonRequest(app, '/api/machine/token', {
    deviceCode: pending.deviceCode,
  });
  await waitFor();
  await expect.poll(() => Date.now() > deadline, { timeout: 5000 }).toBe(true);
  release();
  const result = await poll;
  expect(result.status).toBe(400);
  expect(await responseHasTag(result, 'expired')).toBe(true);
  expect(
    (await db.prepare('SELECT count(*) AS count FROM machine_tokens').first())
      ?.count,
  ).toBe(0);
});
it('all machine endpoints perform at most one D1 read and one batch', async () => {
  reads = 0;
  batches = 0;
  const pending = await createAuthorization(app);
  expect(reads <= 1 && batches <= 1).toBe(true);
  expect((await approve(app, pending.userCode)).status).toBe(204);
  reads = 0;
  batches = 0;
  const result = await jsonRequest(app, '/api/machine/token', {
    deviceCode: pending.deviceCode,
  });
  expect(result.status).toBe(200);
  expect(reads <= 1 && batches <= 1).toBe(true);
  const issued = (await result.json()) as { token: string };
  for (const [method, path, status] of [
    ['GET', 'whoami', 200],
    ['DELETE', 'token', 204],
  ] as const) {
    reads = 0;
    batches = 0;
    expect(
      (
        await fetch(`${app.origin}/api/machine/${path}`, {
          method,
          headers: { Authorization: `Bearer ${issued.token}` },
        })
      ).status,
    ).toBe(status);
    expect(reads <= 1 && batches <= 1).toBe(true);
  }
});
it('creation discards requests that expire while its D1 batch is delayed', async () => {
  for (let i = 0; i < 20; i++) await createAuthorization(app);
  const db = await app.mf.getD1Database('DB');
  const deadline = Date.now() + 1500;
  await db
    .prepare('UPDATE authorizations SET expires_at=?')
    .bind(deadline)
    .run();
  held = '/machine-before-batch';
  const creation = jsonRequest(app, '/api/machine/authorizations', {
    suggestedName: 'new-request',
    client: 'nook test',
  });
  await waitFor();
  await expect.poll(() => Date.now() > deadline, { timeout: 5000 }).toBe(true);
  release();
  expect((await creation).status).toBe(200);
  expect(
    (await db.prepare('SELECT count(*) AS count FROM authorizations').first())
      ?.count,
  ).toBe(1);
});
