import { randomUUID } from 'node:crypto';
import { Log, LogLevel } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { access, accessFixture } from './support/access.ts';
import { seedGrantTree } from './support/grants.ts';
import { deferred } from './support/machines.ts';
import { expectToolError } from './support/mcp.ts';
import {
  listMemoryPage,
  memoryBuckets,
  memoryClient,
  memoryFixture,
  memoryId,
  seedMemories,
  seedMemoryMachine,
  tenTags,
} from './support/memory.ts';
import {
  changedForget,
  forgetSnapshot,
  forgottenId,
  ftsIntegrity,
  removalRows,
  uniqueTerm,
  versionThree,
} from './support/memory-forget.ts';
import { runtime, type TestRuntime } from './support/runtime.ts';
import { vaultCheckpoints } from './support/vault-checkpoints.ts';

const prefix = '# Release process\n\n';
const suffix = `\n\nVersion 3: ${uniqueTerm}`;
const dense =
  prefix +
  '界'.repeat(5400) +
  'x'.repeat(16384 - Buffer.byteLength(prefix + suffix) - 5400 * 3);

it('E6: a losing forget that already passed preflight returns not found', async () => {
  const arrived = deferred();
  const gate = deferred();
  let holding = false;
  let held = false;
  const app = await vaultCheckpoints(async (stage) => {
    if (holding && !held && stage === '/before-batch') {
      held = true;
      arrived.resolve();
      await gate.promise;
    }
    return true;
  });
  let first: ReturnType<ReturnType<typeof memoryClient>['call']> | undefined;
  try {
    await seedMemories(app, [memoryFixture(1)]);
    await versionThree(app);
    const client = memoryClient(app, '2026-07-28');
    holding = true;
    first = client.call('forget', { id: forgottenId, expectedVersion: 3 });
    await arrived.promise;
    const winner = await client.call('forget', {
      id: forgottenId,
      expectedVersion: 3,
    });
    expect(winner.isError).not.toBe(true);
    expect(winner.structuredContent).toEqual({
      id: forgottenId,
      bucket: 'work/acme',
      version: 3,
    });
    gate.resolve();
    expectToolError(await first, 'Memory not found.');
    expect(await removalRows(app)).toHaveLength(1);
  } finally {
    gate.resolve();
    await first;
    await app.close();
  }
});

describe.each(['owner', 'machine'] as const)('Forget #13: %s', (endpoint) => {
  describe.each(['2026-07-28', '2025-06-18'] as const)('%s', (protocol) => {
    let app: TestRuntime;
    let assertion: string;
    let client: ReturnType<typeof memoryClient>;
    const logs: string[] = [];
    beforeAll(async () => {
      const issuer = await accessFixture();
      app = await runtime({
        bindings: access,
        outboundService: issuer.outboundService,
      });
      assertion = await issuer.assertion();
      class PrivateLog extends Log {
        override log(message: string) {
          logs.push(message);
        }
      }
      await app.setBindings(access, {
        log: new PrivateLog(LogLevel.VERBOSE),
        handleRuntimeStdio(stdout, stderr) {
          for (const stream of [stdout, stderr])
            stream.on('data', (chunk) => logs.push(chunk.toString()));
        },
      });
      await seedGrantTree(app, [...memoryBuckets, 'work/other']);
    });
    beforeEach(async () => {
      const db = await app.mf.getD1Database('DB');
      await db.prepare('DELETE FROM memories').run();
      if (
        await db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name='memory_vector_removals'",
          )
          .first()
      )
        await db.prepare('DELETE FROM memory_vector_removals').run();
      await db.prepare('DELETE FROM machine_tokens').run();
      await seedMemories(app, [
        memoryFixture(1, { content: dense, tags: tenTags }),
      ]);
      await versionThree(app);
      const { token } = await seedMemoryMachine(app, ['work/acme']);
      client = memoryClient(app, protocol, {
        machine: endpoint === 'machine',
        headers:
          endpoint === 'machine'
            ? { Authorization: `Bearer ${token}` }
            : { 'Cf-Access-Jwt-Assertion': assertion },
      });
    });
    afterAll(() => app?.close());
    const forget = (input: Record<string, unknown> = {}) =>
      client.call('forget', { id: forgottenId, expectedVersion: 3, ...input });
    const owner = (path: string) =>
      fetch(app.origin + path, {
        headers: { 'Cf-Access-Jwt-Assertion': assertion },
      });
    it('E1/E12: permanent forget removes every version and FTS byte, returning only non-content facts', async () => {
      const current = (await client.call('get', { id: forgottenId }))
        .structuredContent;
      expect(Buffer.byteLength(current?.content as string)).toBe(16384);
      expect(current?.tags).toEqual(tenTags);
      const before = new Date().toISOString();
      const result = await forget();
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        id: forgottenId,
        bucket: 'work/acme',
        version: 3,
      });
      expect(JSON.stringify(result)).not.toContain(uniqueTerm);
      expectToolError(
        await client.call('get', { id: forgottenId }),
        'Memory not found.',
      );
      expect(
        (await owner(`/api/memories/${forgottenId}/versions`)).status,
      ).toBe(404);
      expect(
        await listMemoryPage(app, 'bucket=work/acme', {
          'Cf-Access-Jwt-Assertion': assertion,
        }),
      ).toMatchObject({ memories: [] });
      expect(
        (await (await owner('/api/memories/counts')).json()).counts,
      ).toContainEqual({ bucket: 'work/acme', count: 0 });
      const stored = await forgetSnapshot(app);
      expect(stored.heads).toEqual([]);
      expect(stored.versions).toEqual([]);
      expect(JSON.stringify(stored.fts).toLowerCase()).not.toContain(
        Buffer.from(uniqueTerm).toString('hex'),
      );
      const db = await app.mf.getD1Database('DB');
      expect(
        (
          await db
            .prepare(
              'SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?',
            )
            .bind(uniqueTerm)
            .all()
        ).results,
      ).toEqual([]);
      await ftsIntegrity(app);
      const rows = await removalRows(app);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        id: forgottenId,
        forgotten_at: expect.any(String),
      });
      expect(
        rows[0].forgotten_at >= before &&
          rows[0].forgotten_at <= new Date().toISOString(),
      ).toBe(true);
    });
    if (endpoint === 'machine')
      it('E3/E4/E12: grants precede validation and denied IDs never alter rows or FTS', async () => {
        await seedMemories(app, [
          memoryFixture(2, { bucket: 'personal' }),
          memoryFixture(3, { bucket: 'work/other' }),
          memoryFixture(4, { bucket: 'work' }),
          memoryFixture(5, { bucket: 'me' }),
        ]);
        const machine = await seedMemoryMachine(app, ['work/acme']);
        const restricted = memoryClient(app, protocol, {
          machine: true,
          headers: { Authorization: `Bearer ${machine.token}` },
        });
        const before = await forgetSnapshot(app);
        for (const id of [
          memoryId(2),
          memoryId(3),
          randomUUID(),
          'malformed',
        ]) {
          expectToolError(
            await restricted.call('forget', { id, expectedVersion: 0 }),
            'Memory not found.',
          );
        }
        for (const id of [memoryId(4), memoryId(5)])
          expectToolError(
            await restricted.call('forget', { id, expectedVersion: 0 }),
            'Access to this bucket is forbidden.',
          );
        expect(await forgetSnapshot(app)).toEqual(before);
      });
    it.each([0, -1, 1.5, '2', undefined])(
      'E4: invalid expectedVersion %s is private and has no write',
      async (expectedVersion) => {
        const before = await forgetSnapshot(app);
        const input =
          expectedVersion === undefined
            ? { id: forgottenId }
            : { id: forgottenId, expectedVersion };
        expectToolError(
          await client.call('forget', input),
          'Use a positive integer for expectedVersion.',
        );
        expect(await forgetSnapshot(app)).toEqual(before);
      },
    );
    it('E5: a stale version returns the forget-specific changed message without a write', async () => {
      const before = await forgetSnapshot(app);
      expectToolError(
        await forget({ expectedVersion: 2 }),
        changedForget(3, 2),
      );
      const after = await forgetSnapshot(app);
      // The accepted batch always compacts FTS, including a guarded no-op.
      expect(after.heads).toEqual(before.heads);
      expect(after.versions).toEqual(before.versions);
      expect(after.removals).toEqual(before.removals);
      expect(
        (
          await (
            await app.mf.getD1Database('DB')
          )
            .prepare(
              'SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?',
            )
            .bind(uniqueTerm)
            .all()
        ).results,
      ).toHaveLength(1);
      await ftsIntegrity(app);
    });
    it('E6: one of ten concurrent forgets wins; retries are not found and record only one removal', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => forget()),
      );
      expect(results.filter((r) => !r.isError)).toHaveLength(1);
      for (const result of results.filter((r) => r.isError))
        expectToolError(result, 'Memory not found.');
      expectToolError(await forget(), 'Memory not found.');
      expect(await removalRows(app)).toHaveLength(1);
    });
    it('E7/E8: either writer order preserves the version guard and identical re-remember gets a new ID', async () => {
      const update = await client.call('update', {
        id: forgottenId,
        expectedVersion: 3,
        content: '# Current replacement\nnew fact',
      });
      expect(update.structuredContent).toMatchObject({
        updated: true,
        version: 4,
      });
      expectToolError(await forget(), changedForget(4, 3));
      expect((await forget({ expectedVersion: 4 })).isError).not.toBe(true);
      expectToolError(
        await client.call('update', {
          id: forgottenId,
          expectedVersion: 4,
          content: 'later update',
        }),
        'Memory not found.',
      );
      const remembered = await client.call('remember', {
        bucket: 'work/acme',
        content: '# Current replacement\nnew fact',
      });
      expect(remembered.structuredContent).toMatchObject({
        created: true,
        version: 1,
      });
      expect(remembered.structuredContent?.id).not.toBe(forgottenId);
      expect(
        (
          await client.call('remember', {
            bucket: 'work/acme',
            content: '# Current replacement\nnew fact',
          })
        ).structuredContent,
      ).toMatchObject({ created: false, id: remembered.structuredContent?.id });
    });
    it('E9: the memory blocks bucket deletion until forgotten', async () => {
      await seedMemories(app, [memoryFixture(9, { bucket: 'work/acme/api' })]);
      expectToolError(
        await client.call('delete_bucket', { path: 'work/acme/api' }),
        'Delete its memories first.',
      );
      expect(
        (await forget({ id: memoryId(9), expectedVersion: 1 })).isError,
      ).not.toBe(true);
      expect(
        (await client.call('delete_bucket', { path: 'work/acme/api' })).isError,
      ).not.toBe(true);
    });
    it('E10/E12: insert/delete aborts and missing migration preserve all canonical and index bytes', async () => {
      const db = await app.mf.getD1Database('DB');
      // Before implementation this fails at the missing tool, never at fixture setup.
      expect(
        (await client.listTools()).tools.some((t) => t.name === 'forget'),
      ).toBe(true);
      for (const [table, event] of [
        ['memory_vector_removals', 'INSERT'],
        ['memories', 'DELETE'],
      ] as const) {
        await db
          .prepare(
            `CREATE TRIGGER synthetic_forget_abort BEFORE ${event} ON ${table} BEGIN SELECT RAISE(ABORT,'private content ${uniqueTerm}'); END`,
          )
          .run();
        const before = await forgetSnapshot(app);
        expectToolError(
          await forget(),
          'Service unavailable. Try again later.',
        );
        expect(await forgetSnapshot(app)).toEqual(before);
        await db.prepare('DROP TRIGGER synthetic_forget_abort').run();
      }
      await db.prepare('DROP TABLE memory_vector_removals').run();
      const before = await forgetSnapshot(app);
      expectToolError(await forget(), 'Service unavailable. Try again later.');
      expect(await forgetSnapshot(app)).toEqual(before);
      await db
        .prepare(
          'CREATE TABLE memory_vector_removals (id TEXT PRIMARY KEY CHECK (length(id)=36), forgotten_at TEXT NOT NULL)',
        )
        .run();
      await db
        .prepare(
          'CREATE INDEX memory_vector_removals_age ON memory_vector_removals(forgotten_at,id)',
        )
        .run();
      expect(
        logs.some((message) => message.includes(uniqueTerm)),
        'Storage failures never log memory content',
      ).toBe(false);
    });
    it('E11: discovery documents permanent deletion, read version and lost-response retries without owner policy', async () => {
      const tool = (await client.listTools()).tools.find(
        (t) => t.name === 'forget',
      );
      expect(tool).toBeDefined();
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      });
      expect(tool?.description).toMatch(/permanent/i);
      expect(tool?.description).toMatch(/all versions/i);
      expect(tool?.description).toMatch(
        /expectedVersion.*get|get.*expectedVersion/,
      );
      expect(tool?.description).toMatch(
        /retry.*already gone|already gone.*retry/i,
      );
      expect(tool?.description).not.toMatch(/confirm.*owner|owner.*confirm/i);
      expect(tool?.inputSchema).toMatchObject({
        properties: { expectedVersion: { type: 'number' } },
        required: ['id', 'expectedVersion'],
      });
    });
  });
});
