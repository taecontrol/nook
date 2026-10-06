import { beforeEach, expect, it } from 'vitest';
import {
  createAuthorization,
  jsonRequest,
  ownerRuntime,
} from './support/authorizations.ts';
import { checkpointRuntime } from './support/checkpoint-runtime.ts';
import { approveGrant, issueGrant, seedGrantTree } from './support/grants.ts';
import { machineIdentity } from './support/machines.ts';
import { runtime, type TestRuntime } from './support/runtime.ts';

let app: TestRuntime;
beforeEach(async () => {
  app = await ownerRuntime(await runtime());
  await seedGrantTree(app);
  return () => app.close();
});
it('E1: all is explicit, round-trips through whoami, and an omitted grant cannot approve', async () => {
  const issued = await issueGrant(app);
  expect(
    (
      (await (await machineIdentity(app, issued.token)).json()) as {
        grant: unknown;
      }
    ).grant,
  ).toBe('all');
  const pending = await createAuthorization(app);
  expect(
    (
      await jsonRequest(
        app,
        `/api/authorizations/${pending.userCode}/approve`,
        {
          machineName: 'work-laptop',
        },
      )
    ).status,
  ).toBe(400);
});
it.each([
  { grant: ['work', 'me'], expected: ['me', 'work'], example: 'E2' },
  {
    grant: ['work', 'work/acme', 'work'],
    expected: ['work'],
    example: 'E3',
  },
])(
  '$example: approval persists sorted roots without duplicates or covered descendants',
  async ({ grant, expected }) => {
    const issued = await issueGrant(app, grant);
    expect(issued.grant).toEqual(expected);
    const identity = await machineIdentity(app, issued.token);
    expect(((await identity.json()) as { grant: unknown }).grant).toEqual(
      expected,
    );
  },
);
it.each([
  [],
  ['missing'],
  ['Work'],
  ['work/'],
  false,
  1,
  'work',
  {},
  ['work', 1],
])(
  'E4: invalid grant %# is tagged, leaves the request pending, and cannot exchange a token',
  async (grant) => {
    const pending = await createAuthorization(app);
    const response = await approveGrant(app, pending.userCode, grant);
    expect(response.status).toBe(400);
    const error = (await response.json()) as { _tag: string };
    expect(error._tag).toBe(
      Array.isArray(grant) && grant.includes('missing')
        ? 'GrantBucketNotFound'
        : 'InvalidBucketGrant',
    );
    expect(
      (
        await jsonRequest(app, '/api/machine/token', {
          deviceCode: pending.deviceCode,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await (
          await app.mf.getD1Database('DB')
        )
          .prepare('SELECT status FROM authorizations')
          .first()
      )?.status,
    ).toBe('pending');
    expect((await approveGrant(app, pending.userCode, ['me'])).status).toBe(
      204,
    );
  },
);
it('E4: a missing chosen descendant is rejected even when another chosen root covers it', async () => {
  const pending = await createAuthorization(app);
  const response = await approveGrant(app, pending.userCode, [
    'work',
    'work/missing',
  ]);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ _tag: 'GrantBucketNotFound' });
  expect(
    (
      await (
        await app.mf.getD1Database('DB')
      )
        .prepare('SELECT status FROM authorizations')
        .first()
    )?.status,
  ).toBe('pending');
});
it('E5: deletion immediately before the approval batch rejects the grant atomically and permits choosing again', async () => {
  const labels: string[] = [];
  let deleting = false;
  const measured = await ownerRuntime(
    await checkpointRuntime(async (label) => {
      labels.push(label);
      if (deleting && label === '/owner-before-batch') {
        deleting = false;
        await (await measured.mf.getD1Database('DB'))
          .prepare("DELETE FROM buckets WHERE path LIKE 'work/acme%'")
          .run();
      }
    }),
  );
  try {
    await seedGrantTree(measured);
    const pending = await createAuthorization(measured);
    deleting = true;
    labels.length = 0;
    const response = await approveGrant(measured, pending.userCode, [
      'work/acme',
    ]);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      _tag: 'GrantBucketNotFound',
    });
    expect(labels).toEqual([
      '/owner-read',
      '/owner-before-batch',
      '/owner-batch',
      '/owner-write',
    ]);
    expect(
      (
        await jsonRequest(measured, '/api/machine/token', {
          deviceCode: pending.deviceCode,
        })
      ).status,
    ).toBe(400);
    expect(
      (await approveGrant(measured, pending.userCode, ['me'])).status,
    ).toBe(204);
  } finally {
    await measured.close();
  }
});
