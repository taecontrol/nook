import { randomUUID } from 'node:crypto';
import { Log, LogLevel } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { access, accessFixture } from './support/access.ts';
import { seedGrantTree } from './support/grants.ts';
import { expectPrivate } from './support/machines.ts';
import { expectToolError, type ToolResult } from './support/mcp.ts';
import {
  memoryBuckets,
  memoryClient,
  memoryCounts,
  memoryFixture,
  memoryId,
  seedMemories,
  seedMemoryMachine,
} from './support/memory.ts';
import { runtime, type TestRuntime } from './support/runtime.ts';

describe.each(['owner', 'machine'] as const)('%s Memory MCP', (endpoint) => {
  describe.each(['2026-07-28', '2025-06-18'] as const)('%s', (version) => {
    let app: TestRuntime;
    let issuer: Awaited<ReturnType<typeof accessFixture>>;
    let assertion: string;
    let token: string;
    let machineId: string;
    let client: ReturnType<typeof memoryClient>;
    const logs: string[] = [];
    const outputs: string[] = [];
    const content = '# Release process\nDeploy only from green main.\n';
    beforeAll(async () => {
      issuer = await accessFixture();
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
      await seedGrantTree(app, memoryBuckets);
    });
    beforeEach(async () => {
      const db = await app.mf.getD1Database('DB');
      if (
        await db
          .prepare("SELECT name FROM sqlite_master WHERE name='memories'")
          .first()
      )
        await db.prepare('DELETE FROM memories').run();
      await db.prepare('DELETE FROM machine_tokens').run();
      ({ token, id: machineId } = await seedMemoryMachine(app));
      client = memoryClient(app, version, {
        machine: endpoint === 'machine',
        headers:
          endpoint === 'machine'
            ? {
                Authorization: `Bearer ${token}`,
                'User-Agent': 'codex-mcp-client/0.162.0',
              }
            : {
                'Cf-Access-Jwt-Assertion': assertion,
                'User-Agent': 'codex-mcp-client/0.162.0',
              },
      });
    });
    afterAll(async () => {
      expectPrivate(logs.join('\n') + outputs.join('\n'), [token, assertion]);
      await app?.close();
    });
    async function call(name: string, args: Record<string, unknown>) {
      const result = await client.call(name, args);
      outputs.push(JSON.stringify(result));
      return result;
    }
    function stored(result: ToolResult) {
      expect(
        result.isError,
        'remember stores a memory through the real MCP tool',
      ).not.toBe(true);
      expect(result.structuredContent).toBeDefined();
      return result.structuredContent as {
        created: boolean;
        id: string;
        bucket: string;
        version: number;
        tags: string[];
        createdAt: string;
      };
    }
    it('E1/E2/E4: remember is compact and get returns exact content and authenticated provenance', async () => {
      const before = new Date().toISOString();
      const m = stored(
        await call('remember', {
          bucket: 'work/acme',
          content,
          tags: ['deploy'],
          ...(endpoint === 'machine'
            ? { workingDirectory: '/Users/luis/code/acme-api' }
            : {}),
        }),
      );
      expect(m).toEqual({
        created: true,
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        bucket: 'work/acme',
        version: 1,
        tags: ['deploy'],
        createdAt: expect.any(String),
      });
      expect(
        m.createdAt >= before && m.createdAt <= new Date().toISOString(),
      ).toBe(true);
      const result = await call('get', { id: m.id });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        id: m.id,
        bucket: 'work/acme',
        content,
        tags: ['deploy'],
        version: 1,
        createdAt: m.createdAt,
        updatedAt: m.createdAt,
        provenance: {
          client:
            version === '2026-07-28'
              ? { name: 'claude-code', version: '2.1.289' }
              : { name: 'codex-mcp-client', version: '0.162.0' },
          principal:
            endpoint === 'machine'
              ? { kind: 'machine', id: machineId, name: 'luis-mbp' }
              : { kind: 'owner' },
          workingDirectory:
            endpoint === 'machine' ? '/Users/luis/code/acme-api' : null,
          at: m.createdAt,
        },
      });
      expect(await memoryCounts(app)).toEqual({ memories: 1, versions: 1 });
    });
    it.each([
      ['none', undefined, ''],
      ['controls', undefined, 'client\tbad/1'],
      ['long', undefined, `${'x'.repeat(129)}/1`],
      ['bad envelope', { name: 'bad\nclient', version: '1' }, ''],
      ['long version', undefined, `client/${'1'.repeat(65)}`],
    ])(
      'E3: unusable %s client identity becomes unknown',
      async (_, clientInfo, userAgent) => {
        const headers =
          endpoint === 'machine'
            ? { Authorization: `Bearer ${token}` }
            : { 'Cf-Access-Jwt-Assertion': assertion };
        const fallback = memoryClient(app, version, {
          machine: endpoint === 'machine',
          headers: { ...headers, 'User-Agent': userAgent as string },
          removeClientInfo: true,
          clientInfo,
        });
        const m = stored(
          await fallback.call('remember', { bucket: 'work/acme', content }),
        );
        expect(
          (await fallback.call('get', { id: m.id })).structuredContent
            ?.provenance,
        ).toMatchObject({ client: { name: 'unknown', version: null } });
      },
    );
    it('E2: invalid envelope falls back to the first User-Agent product token', async () => {
      const fallback = memoryClient(app, version, {
        machine: endpoint === 'machine',
        headers: {
          ...(endpoint === 'machine'
            ? { Authorization: `Bearer ${token}` }
            : { 'Cf-Access-Jwt-Assertion': assertion }),
          'User-Agent': 'codex-mcp-client/0.162.0 (sdk, other/9)',
        },
        clientInfo: { name: 'invalid\tclient', version: '1' },
      });
      const m = stored(
        await fallback.call('remember', { bucket: 'work/acme', content }),
      );
      expect(
        (await fallback.call('get', { id: m.id })).structuredContent
          ?.provenance,
      ).toMatchObject({
        client: { name: 'codex-mcp-client', version: '0.162.0' },
      });
    });
    it('E5: a lost-response retry preserves id, tags and both row counts', async () => {
      const first = stored(
        await call('remember', {
          bucket: 'work/acme',
          content,
          tags: ['deploy'],
        }),
      );
      const before = await memoryCounts(app);
      const retry = stored(
        await call('remember', {
          bucket: 'work/acme',
          content,
          tags: ['other'],
        }),
      );
      expect(retry).toEqual({ ...first, created: false });
      expect(await memoryCounts(app)).toEqual(before);
    });
    it('E6: ten concurrent identical writes produce exactly one memory and version', async () => {
      const results = (
        await Promise.all(
          Array.from({ length: 10 }, () =>
            call('remember', { bucket: 'work/acme', content }),
          ),
        )
      ).map(stored);
      expect(new Set(results.map((m) => m.id)).size).toBe(1);
      expect(results.filter((m) => m.created)).toHaveLength(1);
      expect(await memoryCounts(app)).toEqual({ memories: 1, versions: 1 });
    });
    it('E7: buckets and one-byte content differences have distinct identities', async () => {
      const results = [];
      for (const [bucket, text] of [
        ['work', 'x'],
        ['work/acme', 'x'],
        ['work/acme', 'x\n'],
      ])
        results.push(stored(await call('remember', { bucket, content: text })));
      expect(new Set(results.map((m) => m.id)).size).toBe(3);
      expect(await memoryCounts(app)).toEqual({ memories: 3, versions: 3 });
    });
    it('E8/E9/E33: restricted writes deny siblings and reads mask absent, malformed and denied ids', async () => {
      await seedMemories(app, [
        memoryFixture(1, {
          bucket: 'personal',
          content: 'synthetic-private-personal-memory',
        }),
        memoryFixture(2, { bucket: 'me' }),
        memoryFixture(3, { bucket: 'work' }),
      ]);
      const restricted = memoryClient(app, version, {
        machine: true,
        headers: { Authorization: `Bearer ${token}` },
      });
      const before = await memoryCounts(app);
      expectToolError(
        await restricted.call('remember', {
          bucket: 'personal',
          content: 'synthetic-failed-write-content',
        }),
        'Access to this bucket is forbidden.',
      );
      for (const id of [memoryId(1), randomUUID(), 'malformed']) {
        const result = await restricted.call('get', { id });
        expectToolError(result, 'Memory not found.');
        expectPrivate(JSON.stringify(result), [
          'synthetic-private-personal-memory',
          token,
          assertion,
        ]);
      }
      for (const id of [memoryId(2), memoryId(3)])
        expect((await restricted.call('get', { id })).isError).not.toBe(true);
      expect(await memoryCounts(app)).toEqual(before);
    });
    it('E10: a valid absent bucket reports not found and writes nothing', async () => {
      expectToolError(
        await call('remember', { bucket: 'work/absent', content }),
        'Bucket not found.',
      );
      expect(await memoryCounts(app)).toEqual({ memories: 0, versions: 0 });
    });
    it('E11: the 16 KiB UTF-8 boundary and ten tags are accepted byte for byte', async () => {
      const text = `${'é'.repeat(8191)}ab`;
      const tags = Array.from({ length: 10 }, (_, i) => `tag-${i}`);
      const m = stored(
        await call('remember', { bucket: 'work/acme', content: text, tags }),
      );
      expect((await call('get', { id: m.id })).structuredContent).toMatchObject(
        { content: text, tags },
      );
    });
    it.each([
      ['16385 bytes', { content: `${'é'.repeat(8192)}a` }],
      ['blank', { content: ' \n\t ' }],
      ['NUL', { content: 'a\0b' }],
      ['surrogate', { content: 'a\ud800b' }],
      [
        'eleven tags',
        { tags: Array.from({ length: 11 }, (_, i) => `tag-${i}`) },
      ],
      ['uppercase', { tags: ['Deploy'] }],
      ['duplicate', { tags: ['deploy', 'deploy'] }],
      ['33 characters', { tags: ['a'.repeat(33)] }],
      ['grammar', { tags: ['bad--tag'] }],
      ['relative directory', { workingDirectory: 'code/acme' }],
    ])(
      'E11/E33: invalid %s writes nothing and never echoes content',
      async (label, input) => {
        const result = await call('remember', {
          bucket: 'work/acme',
          content: 'synthetic-failed-write-content',
          ...input,
        });
        expect(result.isError).toBe(true);
        if (label === 'uppercase')
          expectToolError(result, 'Use lowercase letters: deploy');
        expectPrivate(JSON.stringify(result) + logs.join('\n'), [
          'synthetic-failed-write-content',
          token,
          assertion,
        ]);
        expect(await memoryCounts(app)).toEqual({ memories: 0, versions: 0 });
      },
    );
    it('E12: discovery documents explicit buckets, safe retries and read annotations', async () => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'create_bucket',
        'delete_bucket',
        'get',
        'list_buckets',
        'list_secrets',
        'remember',
      ]);
      const remember = tools.find((t) => t.name === 'remember');
      expect(remember?.description).toMatch(/bucket explicitly/i);
      expect(remember?.description).toMatch(/ask the owner/i);
      expect(remember?.description).toMatch(/retry.*safe|safe.*retry/i);
      expect(remember?.annotations).toMatchObject({
        idempotentHint: true,
        destructiveHint: false,
      });
      expect(tools.find((t) => t.name === 'get')?.annotations).toMatchObject({
        readOnlyHint: true,
      });
      expect(
        tools.find((t) => t.name === 'delete_bucket')?.description,
      ).toContain('memories');
      expect(Object.keys(remember?.inputSchema.properties as object)).toEqual([
        'bucket',
        'content',
        'tags',
        'workingDirectory',
      ]);
    });
    it('E13: revocation denies remember before writes and retains the machine name snapshot', async () => {
      const machine = memoryClient(app, version, {
        machine: true,
        headers: { Authorization: `Bearer ${token}` },
      });
      const m = stored(
        await machine.call('remember', { bucket: 'work/acme', content }),
      );
      const response = await fetch(`${app.origin}/api/machines/${machineId}`, {
        method: 'DELETE',
        headers: { 'Cf-Access-Jwt-Assertion': assertion },
      });
      expect(response.status).toBe(204);
      const before = await memoryCounts(app);
      const rejected = await machine.request('tools/call', {
        name: 'remember',
        arguments: { bucket: 'work/acme', content: 'after revocation' },
      });
      expect(rejected.status).toBe(401);
      expect(await rejected.json()).toEqual({ _tag: 'Unauthorized' });
      expect(await memoryCounts(app)).toEqual(before);
      const owner = memoryClient(app, version, {
        headers: { 'Cf-Access-Jwt-Assertion': assertion },
      });
      expect(
        (await owner.call('get', { id: m.id })).structuredContent?.provenance,
      ).toMatchObject({
        principal: { kind: 'machine', id: machineId, name: 'luis-mbp' },
      });
    });
    it('E14/E33: real D1 failures expose only unavailable and roll back the batch', async () => {
      const db = await app.mf.getD1Database('DB');
      await db
        .prepare(
          "CREATE TRIGGER fail_memory BEFORE INSERT ON memory_versions BEGIN SELECT RAISE(ABORT, 'synthetic-failed-write-content'); END",
        )
        .run();
      try {
        expectToolError(
          await call('remember', {
            bucket: 'work/acme',
            content: 'synthetic-failed-write-content',
          }),
          'Service unavailable. Try again later.',
        );
        expect(await memoryCounts(app)).toEqual({ memories: 0, versions: 0 });
      } finally {
        await db.prepare('DROP TRIGGER fail_memory').run();
      }
      await seedMemories(app, [memoryFixture(1)]);
      await db
        .prepare('ALTER TABLE memory_versions RENAME TO unavailable_versions')
        .run();
      try {
        expectToolError(
          await call('get', { id: memoryId(1) }),
          'Service unavailable. Try again later.',
        );
      } finally {
        await db
          .prepare('ALTER TABLE unavailable_versions RENAME TO memory_versions')
          .run();
      }
      expectPrivate(logs.join('\n'), [
        'synthetic-failed-write-content',
        'unavailable_versions',
        token,
        assertion,
      ]);
    });
  });
});
