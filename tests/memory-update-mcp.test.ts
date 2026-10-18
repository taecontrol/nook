import { createHash, randomUUID } from 'node:crypto';
import type { Memory } from '@nook/contract';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { access, accessFixture } from './support/access.ts';
import { seedGrantTree } from './support/grants.ts';
import { expectToolError, type ToolResult } from './support/mcp.ts';
import {
  memoryBuckets,
  memoryClient,
  memoryFixture,
  memoryId,
  seedMemories,
  seedMemoryMachine,
} from './support/memory.ts';
import { runtime, type TestRuntime } from './support/runtime.ts';

const old = '# Release\nblueberry before promotion';
const next = '# Release\nkiwi after manual promotion';
type Updated = Pick<
  Memory,
  'id' | 'bucket' | 'version' | 'tags' | 'createdAt' | 'updatedAt'
> & { updated: boolean };
const changed = (n: number, expected: number) =>
  `This memory changed: it is now version ${n}, not ${expected}. Get it again before updating.`;
function success(result: ToolResult) {
  expect(
    result.isError,
    'The update tool succeeds at the MCP boundary',
  ).not.toBe(true);
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Updated;
}
describe.each(['owner', 'machine'] as const)('Update #12: %s', (endpoint) => {
  describe.each(['2026-07-28', '2025-06-18'] as const)('%s', (protocol) => {
    let app: TestRuntime;
    let assertion: string;
    let token: string;
    let machineId: string;
    let client: ReturnType<typeof memoryClient>;
    beforeAll(async () => {
      const issuer = await accessFixture();
      app = await runtime({
        bindings: access,
        outboundService: issuer.outboundService,
      });
      assertion = await issuer.assertion();
      await seedGrantTree(app, memoryBuckets);
    });
    beforeEach(async () => {
      const db = await app.mf.getD1Database('DB');
      await db.prepare('DELETE FROM memories').run();
      await db.prepare('DELETE FROM machine_tokens').run();
      ({ token, id: machineId } = await seedMemoryMachine(app, ['work/acme']));
      await db
        .prepare("UPDATE machine_tokens SET machine_name='ci' WHERE id=?")
        .bind(machineId)
        .run();
      await seedMemories(app, [
        memoryFixture(1, {
          content: old,
          principal: { kind: 'machine', id: 'original', name: 'laptop' },
        }),
      ]);
      client = memoryClient(app, protocol, {
        machine: endpoint === 'machine',
        removeClientInfo: true,
        headers: {
          ...(endpoint === 'machine'
            ? { Authorization: `Bearer ${token}` }
            : { 'Cf-Access-Jwt-Assertion': assertion }),
          'User-Agent': 'codex-mcp-client/0.162.0',
        },
      });
    });
    afterAll(() => app?.close());
    const update = (overrides: Record<string, unknown> = {}) =>
      client.call('update', {
        id: memoryId(1),
        expectedVersion: 1,
        content: next,
        workingDirectory: '/home/runner/acme',
        ...overrides,
      });
    async function snapshot() {
      const db = await app.mf.getD1Database('DB');
      return {
        heads: (await db.prepare('SELECT * FROM memories ORDER BY id').all())
          .results,
        versions: (
          await db
            .prepare('SELECT * FROM memory_versions ORDER BY memory_id,version')
            .all()
        ).results,
      };
    }
    async function integrity() {
      expect(
        await (await app.mf.getD1Database('DB'))
          .prepare(
            "INSERT INTO memories_fts(memories_fts,rank) VALUES ('integrity-check',1)",
          )
          .run(),
      ).toMatchObject({ success: true });
    }
    it('E1/E3/E5: versions retain independent provenance; retries return current facts with no write', async () => {
      const original = (await client.call('get', { id: memoryId(1) }))
        .structuredContent as Memory;
      const before = new Date().toISOString();
      const result = success(await update());
      expect(result).toEqual({
        updated: true,
        id: memoryId(1),
        bucket: 'work/acme',
        version: 2,
        tags: ['deploy'],
        createdAt: original.createdAt,
        updatedAt: expect.any(String),
      });
      const current = (await client.call('get', { id: result.id }))
        .structuredContent as Memory;
      expect(current).toEqual({
        ...original,
        content: next,
        version: 2,
        updatedAt: result.updatedAt,
        provenance: {
          principal:
            endpoint === 'machine'
              ? { kind: 'machine', id: machineId, name: 'ci' }
              : { kind: 'owner' },
          client: { name: 'codex-mcp-client', version: '0.162.0' },
          workingDirectory: '/home/runner/acme',
          at: result.updatedAt,
        },
      });
      expect(
        result.updatedAt >= before &&
          result.updatedAt <= new Date().toISOString(),
      ).toBe(true);
      const response = await fetch(
        `${app.origin}/api/memories/${result.id}/versions`,
        { headers: { 'Cf-Access-Jwt-Assertion': assertion } },
      );
      expect(response.status).toBe(200);
      expect((await response.json()).versions).toEqual([
        {
          version: 2,
          content: next,
          tags: ['deploy'],
          provenance: current.provenance,
        },
        {
          version: 1,
          content: old,
          tags: ['deploy'],
          provenance: original.provenance,
        },
      ]);
      const stored = await snapshot();
      expect(success(await update())).toEqual({ ...result, updated: false });
      expect(await snapshot()).toEqual(stored);
      expect(
        (await client.call('get', { id: result.id })).structuredContent,
      ).toEqual(current);
      await integrity();
    });
    it('E2: omitted, cleared, replaced and reordered tags are exact, including tags-only versions', async () => {
      expect(success(await update()).tags).toEqual(['deploy']);
      expect(
        success(await update({ expectedVersion: 2, tags: [] })),
      ).toMatchObject({ updated: true, version: 3, tags: [] });
      expect(
        success(
          await update({ expectedVersion: 3, tags: ['staging', 'deploy'] }),
        ),
      ).toMatchObject({
        updated: true,
        version: 4,
        tags: ['staging', 'deploy'],
      });
      expect(
        success(
          await update({ expectedVersion: 4, tags: ['deploy', 'staging'] }),
        ),
      ).toMatchObject({
        updated: true,
        version: 5,
        tags: ['deploy', 'staging'],
      });
      expect(
        (await client.call('get', { id: memoryId(1) })).structuredContent,
      ).toMatchObject({ content: next, version: 5 });
      await integrity();
    });
    it('E4: a lost-response retry after an intervening writer is stale and changes nothing', async () => {
      success(await update());
      success(
        await update({ expectedVersion: 2, content: 'Intervening writer' }),
      );
      const before = await snapshot();
      expectToolError(await update(), changed(3, 1));
      expect(await snapshot()).toEqual(before);
    });
    it('E6/E10: duplicates name byte-identical current memories; stale precedes duplicate and own old text is reusable', async () => {
      const remembered = await client.call('remember', {
        bucket: 'work/acme',
        content: 'Collision target',
      });
      const id = remembered.structuredContent?.id;
      const before = await snapshot();
      expectToolError(
        await update({ content: 'Collision target' }),
        `Memory ${id} in this bucket already has this content.`,
      );
      expect(await snapshot()).toEqual(before);
      success(await update());
      const current = await snapshot();
      expectToolError(
        await update({ content: 'Collision target' }),
        changed(2, 1),
      );
      expect(await snapshot()).toEqual(current);
      const retryRemember = await client.call('remember', {
        bucket: 'work/acme',
        content: next,
      });
      expect(retryRemember.structuredContent).toMatchObject({
        id: memoryId(1),
        created: false,
        version: 2,
      });
      success(await update({ expectedVersion: 2, content: old }));
      success(await update({ expectedVersion: 3, content: next }));
      expect(
        (await client.call('remember', { bucket: 'work/acme', content: old }))
          .structuredContent,
      ).toMatchObject({ created: true });
      await seedMemories(app, [
        memoryFixture(2, {
          bucket: 'personal',
          content: 'Other bucket content',
        }),
      ]);
      expect(
        success(
          await update({ expectedVersion: 4, content: 'Other bucket content' }),
        ),
      ).toMatchObject({ updated: true, version: 5 });
      await integrity();
    });
    it.each(['self', 'other'] as const)(
      'hash safety: a %s hash collision never writes or names a byte-different duplicate',
      async (kind) => {
        const db = await app.mf.getD1Database('DB');
        if (kind === 'other')
          await seedMemories(app, [
            memoryFixture(2, {
              content: 'Different bytes under the requested digest',
            }),
          ]);
        // Reproduce the collision state without claiming a real SHA-256 collision.
        await db
          .prepare('UPDATE memories SET content_hash=? WHERE id=?')
          .bind(
            createHash('sha256').update(next).digest('hex'),
            memoryId(kind === 'self' ? 1 : 2),
          )
          .run();
        const before = await snapshot();
        expectToolError(
          await update(),
          'Service unavailable. Try again later.',
        );
        expect(await snapshot()).toEqual(before);
        await integrity();
      },
    );
    if (endpoint === 'machine')
      it('E7: forbidden ancestors and masked missing, malformed and unreadable ids never write or disclose content', async () => {
        await seedMemories(app, [
          memoryFixture(2, { bucket: 'work' }),
          memoryFixture(3, { bucket: 'me' }),
          memoryFixture(4, {
            bucket: 'personal',
            content: 'private-sibling-text',
          }),
        ]);
        const restricted = memoryClient(app, protocol, {
          machine: true,
          headers: { Authorization: `Bearer ${token}` },
        });
        const before = await snapshot();
        for (const [id, message] of [
          [memoryId(2), 'Access to this bucket is forbidden.'],
          [memoryId(3), 'Access to this bucket is forbidden.'],
          [memoryId(4), 'Memory not found.'],
          [randomUUID(), 'Memory not found.'],
          ['malformed', 'Memory not found.'],
        ]) {
          for (const expectedVersion of [1, undefined]) {
            const result = await restricted.call('update', {
              id,
              expectedVersion,
              content: next,
            });
            expectToolError(result, message);
            expect(JSON.stringify(result)).not.toContain(
              'private-sibling-text',
            );
            expect(await snapshot()).toEqual(before);
          }
        }
        await integrity();
      });
    it.each([
      [{ content: '' }, 'Enter memory content.'],
      [
        { content: `${'é'.repeat(8192)}a` },
        'Memory content can be at most 16 KiB.',
      ],
      [{ content: 'private\0text' }, 'Memory content cannot contain NUL.'],
      [{ content: 'private\ud800text' }, 'Use valid Unicode for the content.'],
      [
        { tags: Array.from({ length: 11 }, (_, i) => `tag-${i}`) },
        'A memory can have at most 10 tags.',
      ],
      [{ tags: ['deploy', 'deploy'] }, 'Use each tag only once.'],
      [{ tags: ['Deploy'] }, 'Use lowercase letters: deploy'],
      [
        { workingDirectory: 'relative' },
        'Working directory must be an absolute path of 1 to 4096 bytes.',
      ],
      [{ expectedVersion: 0 }, 'Use a positive integer for expectedVersion.'],
      [
        { expectedVersion: undefined },
        'Use a positive integer for expectedVersion.',
      ],
      [{ expectedVersion: 1.5 }, 'Use a positive integer for expectedVersion.'],
      [{ expectedVersion: '1' }, 'Use a positive integer for expectedVersion.'],
    ])(
      'E8: invalid input $# returns the contract message without writing',
      async (input, message) => {
        const before = await snapshot();
        const result = await update(input);
        expectToolError(result, message);
        expect(JSON.stringify(result)).not.toContain('private');
        expect(JSON.stringify(result)).not.toContain(next);
        expect(await snapshot()).toEqual(before);
        await integrity();
      },
    );
    it.each([false, true])(
      'E9: ten parallel updates, identical=%s, append exactly one row',
      async (identical) => {
        const results = await Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            update({ content: identical ? next : `new content ${i}` }),
          ),
        );
        expect(
          results.filter((r) => r.structuredContent?.updated === true),
        ).toHaveLength(1);
        if (identical)
          expect(
            results.filter((r) => r.structuredContent?.updated === false),
          ).toHaveLength(9);
        else {
          expect(results.filter((r) => r.isError)).toHaveLength(9);
          for (const result of results.filter((r) => r.isError))
            expectToolError(result, changed(2, 1));
        }
        expect((await snapshot()).versions).toHaveLength(2);
        await integrity();
      },
    );
    it('E11: failures in S1 or S2 roll back head, versions, FTS and marker; identical retry succeeds', async () => {
      const db = await app.mf.getD1Database('DB');
      for (const operation of [
        'INSERT ON memory_versions',
        'UPDATE OF current_version ON memories',
      ]) {
        const before = await snapshot();
        await db
          .prepare(
            `CREATE TRIGGER fail_update BEFORE ${operation} BEGIN SELECT RAISE(ABORT,'private update failure'); END`,
          )
          .run();
        try {
          const result = await update();
          expectToolError(result, 'Service unavailable. Try again later.');
          expect(JSON.stringify(result)).not.toContain('private');
          expect(await snapshot()).toEqual(before);
          await integrity();
        } finally {
          await db.prepare('DROP TRIGGER fail_update').run();
        }
      }
      expect(success(await update()).updated).toBe(true);
    });
    if (endpoint === 'machine')
      it('E12: revoked tokens get 401 before SDK dispatch and do not write', async () => {
        const db = await app.mf.getD1Database('DB');
        await db
          .prepare('DELETE FROM machine_tokens WHERE id=?')
          .bind(machineId)
          .run();
        const before = await snapshot();
        const revoked = memoryClient(app, protocol, {
          machine: true,
          headers: { Authorization: `Bearer ${token}` },
        });
        const response = await revoked.request('tools/call', {
          name: 'update',
          arguments: { id: memoryId(1), expectedVersion: 1, content: next },
        });
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ _tag: 'Unauthorized' });
        expect(await snapshot()).toEqual(before);
      });
    it('E13: update describes guarded, destructive, idempotent updates', async () => {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === 'update');
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      });
      for (const phrase of [
        /version.*get/i,
        /omitted tags.*kept/i,
        /\[\].*clear/i,
        /duplicate.*other memory/i,
        /retry.*safe/i,
        /changed.*another writer/i,
      ])
        expect(tool?.description).toMatch(phrase);
      expect(Object.keys(tool?.inputSchema.properties as object)).toEqual([
        'id',
        'expectedVersion',
        'content',
        'tags',
        'workingDirectory',
      ]);
    });
  });
});
