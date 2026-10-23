import { afterEach, expect, it } from 'vitest';
import { handlerForPrincipal } from '../apps/worker/src/index.ts';
import { access, accessFixture } from './support/access.ts';
import { seedGrantTree } from './support/grants.ts';
import { expectToolError } from './support/mcp.ts';
import {
  memoryBuckets,
  memoryClient,
  memoryFixture,
  memoryId,
  memoryRuntime,
  seedMemories,
  seedMemoryMachine,
} from './support/memory.ts';
import {
  changedForget,
  forgetSnapshot,
  forgottenId,
  versionThree,
} from './support/memory-forget.ts';
import { runtime, type TestRuntime } from './support/runtime.ts';
import { vaultCheckpoints } from './support/vault-checkpoints.ts';

let app: TestRuntime;
afterEach(() => app?.close());
const remove = (version = '3', headers: HeadersInit = {}) =>
  fetch(
    `${app.origin}/api/memories/${forgottenId}${version ? `?expectedVersion=${version}` : ''}`,
    { method: 'DELETE', headers },
  );
it('E17: owner DELETE has exact success, missing, stale and validation outcomes', async () => {
  app = await memoryRuntime();
  await seedMemories(app, [memoryFixture(1)]);
  await versionThree(app);
  const stale = await remove('2');
  expect(stale.status).toBe(409);
  expect(await stale.json()).toEqual({
    _tag: 'MemoryChanged',
    message: changedForget(3, 2),
  });
  for (const version of [
    '',
    '0',
    '-1',
    '1.5',
    '02',
    'NaN',
    '9007199254740992',
  ]) {
    const invalid = await remove(version);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      _tag: 'InvalidMemory',
      message: 'Use a positive integer for expectedVersion.',
    });
  }
  const response = await remove();
  expect(response.status).toBe(204);
  expect(await response.text()).toBe('');
  const missing = await remove();
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({
    _tag: 'MemoryNotFound',
    message: 'Memory not found.',
  });
});
it('E17: the owner route rejects machine credentials, foreign Origin and outside-grant memories before validation', async () => {
  const issuer = await accessFixture();
  app = await runtime({
    bindings: access,
    outboundService: issuer.outboundService,
  });
  const assertion = await issuer.assertion();
  await seedGrantTree(app, memoryBuckets);
  await seedMemories(app, [
    memoryFixture(1),
    memoryFixture(2, { bucket: 'personal' }),
  ]);
  const before = await forgetSnapshot(app);
  expect(
    (
      await remove('1', {
        Origin: 'https://foreign.example',
        'Cf-Access-Jwt-Assertion': assertion,
      })
    ).status,
  ).toBe(403);
  const handler = handlerForPrincipal(
    'owner@nook.test',
    await app.mf.getD1Database('DB'),
    ['work/acme'],
  );
  const denied = await handler(
    new Request(
      `http://nook.test/api/memories/${memoryId(2)}?expectedVersion=0`,
      { method: 'DELETE' },
    ),
  );
  expect(denied.status).toBe(404);
  const machine = await seedMemoryMachine(app);
  await app.setBindings({});
  expect(
    (await remove('1', { Authorization: `Bearer ${machine.token}` })).status,
  ).toBe(401);
  expect(await forgetSnapshot(app)).toEqual(before);
});
it.each([4, 5])(
  'E10: a D1 error at batch statement %s, after the removal record and head deletion, rolls back every memory/index/removal write',
  async (failBatchStatement) => {
    const labels: string[] = [];
    app = await vaultCheckpoints(
      async (label) => {
        labels.push(label);
        return true;
      },
      undefined,
      false,
      {
        failBatchStatement,
        failBatchSize: 6,
        observeBatchSize: true,
      },
    );
    await seedMemories(app, [memoryFixture(1)]);
    await versionThree(app);
    const before = await forgetSnapshot(app);
    const result = await memoryClient(app, '2026-07-28').call('forget', {
      id: forgottenId,
      expectedVersion: 3,
    });
    expect(labels).toContain('/batch-6');
    expectToolError(result, 'Service unavailable. Try again later.');
    expect(await forgetSnapshot(app)).toEqual(before);
  },
);
it('E4/E24: malformed IDs cost no D1 call and every authorized outcome uses one preflight plus one six-statement file-aware batch', async () => {
  const labels: string[] = [];
  app = await vaultCheckpoints(
    async (label) => {
      labels.push(label);
      return true;
    },
    undefined,
    false,
    { observeBatchSize: true },
  );
  await seedMemories(app, [memoryFixture(1)]);
  const client = memoryClient(app, '2026-07-28');
  labels.length = 0;
  expectToolError(
    await client.call('forget', { id: 'malformed', expectedVersion: 0 }),
    'Memory not found.',
  );
  expect(labels).toEqual([]);
  for (const version of [2, 1]) {
    labels.length = 0;
    const result = await client.call('forget', {
      id: forgottenId,
      expectedVersion: version,
    });
    expect(result.isError === true).toBe(version === 2);
    expect(labels).toEqual([
      '/statement',
      '/before-batch',
      '/batch-6',
      '/after-batch',
    ]);
  }
});
