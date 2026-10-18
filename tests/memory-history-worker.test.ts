import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { handlerForPrincipal } from '../apps/worker/src/index.ts';
import { deferred } from './support/machines.ts';
import {
  memoryClient,
  memoryFixture,
  memoryId,
  memoryRuntime,
  seedMemories,
  seedMemoryMachine,
} from './support/memory.ts';
import { vaultCheckpoints } from './support/vault-checkpoints.ts';

let app: Awaited<ReturnType<typeof memoryRuntime>>;
beforeAll(async () => {
  app = await memoryRuntime();
  await seedMemories(app, [
    memoryFixture(1),
    memoryFixture(2, { bucket: 'personal', content: 'private history text' }),
  ]);
});
afterAll(() => app?.close());
it('history returns not found when forget commits after its authorization preflight', async () => {
  const arrived = deferred();
  const gate = deferred();
  let holding = false;
  let held = false;
  const raced = await vaultCheckpoints(
    async (stage) => {
      if (holding && !held && stage === '/after-statement') {
        held = true;
        arrived.resolve();
        await gate.promise;
      }
      return true;
    },
    undefined,
    false,
    { observeStatements: true },
  );
  let read: Promise<Response> | undefined;
  try {
    await seedMemories(raced, [memoryFixture(1)]);
    holding = true;
    read = fetch(`${raced.origin}/api/memories/${memoryId(1)}/versions`);
    await arrived.promise;
    const forgotten = await memoryClient(raced, '2026-07-28').call('forget', {
      id: memoryId(1),
      expectedVersion: 1,
    });
    expect(forgotten.isError).not.toBe(true);
    gate.resolve();
    const response = await read;
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      _tag: 'MemoryNotFound',
      message: 'Memory not found.',
    });
  } finally {
    gate.resolve();
    await read;
    await raced.close();
  }
});
it('history returns an empty terminal page for a live memory with no older versions', async () => {
  const response = await fetch(
    `${app.origin}/api/memories/${memoryId(1)}/versions?before=1`,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ versions: [], next: null });
});
it('E20: history rejects malformed boundaries after authorization and accepts a positive integer version', async () => {
  for (const before of [
    '0',
    '1.5',
    '-1',
    '999999999999999999999',
    'junk',
    '02',
  ]) {
    const response = await fetch(
      `${app.origin}/api/memories/${memoryId(1)}/versions?${new URLSearchParams({ before })}`,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ _tag: 'InvalidMemoryCursor' });
  }
  const valid = await fetch(
    `${app.origin}/api/memories/${memoryId(1)}/versions?before=2`,
  );
  expect(valid.status).toBe(200);
  expect((await valid.json()).versions).toHaveLength(1);
  const handler = handlerForPrincipal(
    'owner@nook.test',
    await app.mf.getD1Database('DB'),
    ['work/acme'],
  );
  const denied = await handler(
    new Request(
      `http://nook.test/api/memories/${memoryId(2)}/versions?before=0`,
    ),
  );
  expect(denied.status).toBe(404);
});
it('E20/E21: existing memories have one exact version, grant denials are 404, and machine credentials cannot reach history', async () => {
  const response = await fetch(
    `${app.origin}/api/memories/${memoryId(1)}/versions`,
  );
  expect(response.status).toBe(200);
  const original = await (
    await fetch(`${app.origin}/api/memories/${memoryId(1)}`)
  ).json();
  expect(await response.json()).toMatchObject({
    versions: [
      {
        version: 1,
        content: original.content,
        tags: original.tags,
        provenance: original.provenance,
      },
    ],
    next: null,
  });
  const handler = handlerForPrincipal(
    'owner@nook.test',
    await app.mf.getD1Database('DB'),
    ['work/acme'],
  );
  for (const id of [memoryId(2), randomUUID(), 'malformed']) {
    const denied = await handler(
      new Request(`http://nook.test/api/memories/${id}/versions`),
    );
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain('private history text');
  }
  const machine = await seedMemoryMachine(app);
  await app.setBindings({});
  try {
    for (const path of [
      `/api/memories/${memoryId(1)}/versions`,
      `/api/machine/memories/${memoryId(1)}/versions`,
    ]) {
      const denied = await fetch(app.origin + path, {
        headers: { Authorization: `Bearer ${machine.token}` },
      });
      expect(denied.status).toBe(path.includes('/machine/') ? 404 : 401);
    }
  } finally {
    await app.setBindings({
      LOCAL_OWNER: 'synthetic-owner',
      LOCAL_ORIGIN: app.origin,
    });
  }
});
it('E15: every authorized outcome uses a bucket preflight plus one three-statement batch', async () => {
  const labels: string[] = [];
  const measured = await vaultCheckpoints(
    async (label) => {
      labels.push(label);
      return true;
    },
    undefined,
    false,
    { observeBatchSize: true },
  );
  try {
    await seedMemories(measured, [
      memoryFixture(1),
      memoryFixture(2, { content: 'Other current memory' }),
    ]);
    const client = memoryClient(measured, '2026-07-28');
    for (const [input, outcome] of [
      [
        { expectedVersion: 1, content: 'New content' },
        { updated: true, version: 2 },
      ],
      [
        { expectedVersion: 1, content: 'New content' },
        { updated: false, version: 2 },
      ],
      [{ expectedVersion: 1, content: 'Stale content' }, { isError: true }],
      [
        { expectedVersion: 2, content: 'Other current memory' },
        { isError: true },
      ],
    ] as const) {
      labels.length = 0;
      const result = await client.call('update', { id: memoryId(1), ...input });
      expect(result.structuredContent ?? result).toMatchObject(outcome);
      expect(labels).toEqual([
        '/statement',
        '/before-batch',
        '/batch-3',
        '/after-batch',
      ]);
    }
  } finally {
    await measured.close();
  }
});
