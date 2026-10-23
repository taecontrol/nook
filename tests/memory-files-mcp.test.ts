import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Log, LogLevel } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { access, accessFixture } from './support/access.ts';
import { auditRows } from './support/audit.ts';
import { privateKeyring } from './support/cli.ts';
import { expectToolError, type ToolResult } from './support/mcp.ts';
import {
  memoryClient,
  memoryFixture,
  memoryId,
  seedMemories,
  typicalMemories,
} from './support/memory.ts';
import {
  type AttachedFile,
  attachFile,
  downloadFile,
  fileBucket,
  fileMachine,
  fileMemory,
  fileObjects,
  fileRows,
  fileSnapshot,
  type MemoryFile,
  pdfName,
  seedFile,
  seedFileMemory,
} from './support/memory-files.ts';
import { configureFilesCli } from './support/memory-files-cli.ts';
import {
  type FilesRuntime,
  filesRuntime,
} from './support/memory-files-runtime.ts';
import { changedForget } from './support/memory-forget.ts';
import { expectNoValue } from './support/vault.ts';

function structured(result: ToolResult) {
  expect(result.isError, 'The real MCP tool succeeds').not.toBe(true);
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}
const tripCount = (labels: string[]) =>
  labels.filter((l) => l === '/statement' || l === '/after-batch').length;

describe.each(['owner', 'machine'] as const)(
  'Memory files %s MCP',
  (endpoint) => {
    describe.each(['2026-07-28', '2025-06-18'] as const)('%s', (protocol) => {
      let app: FilesRuntime;
      let machine: Awaited<ReturnType<typeof fileMachine>>;
      let assertion: string;
      let client: ReturnType<typeof memoryClient>;
      beforeEach(async () => {
        const issuer = await accessFixture();
        app = await filesRuntime({
          owner: { bindings: access, outboundService: issuer.outboundService },
          search: true,
        });
        machine = await seedFileMemory(app);
        assertion = await issuer.assertion();
        if (!app.services)
          throw new Error('The search stand-ins must be installed.');
        app.services.failEmbedding = true;
        client = memoryClient(app, protocol, {
          machine: endpoint === 'machine',
          headers:
            endpoint === 'machine'
              ? { Authorization: `Bearer ${machine.token}` }
              : { 'Cf-Access-Jwt-Assertion': assertion },
        });
      });
      afterEach(() => app?.close());
      const ownerHeaders = () => ({ 'Cf-Access-Jwt-Assertion': assertion });
      const get = () => client.call('get', { id: fileMemory });
      const search = () =>
        client.call('search', { bucket: fileBucket, query: 'Attachment' });
      const detach = (sha256: string, name = pdfName, id = fileMemory) =>
        client.call('detach', { id, name, sha256 });

      it('E18: memories without files have empty get/search metadata, and the owner feed shape stays unchanged', async () => {
        const result = structured(await get());
        expect(result.files).toEqual([]);
        const results = structured(await search()).results as Record<
          string,
          unknown
        >[];
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
          id: fileMemory,
          files: [],
          fileCount: 0,
        });
        const response = await fetch(
          `${app.origin}/api/memories?bucket=${fileBucket}`,
          { headers: ownerHeaders() },
        );
        expect(response.status).toBe(200);
        const feed = (await response.json()).memories;
        expect(Object.keys(feed[0]).sort()).toEqual([
          'bucket',
          'createdAt',
          'id',
          'provenance',
          'tags',
          'title',
          'updatedAt',
          'version',
        ]);
      });
      it('E3/E18: get lists every file by name and search exposes at most ten compact files with exact counts, without a D1 trip', async () => {
        app.labels.length = 0;
        await get();
        const getTrips = tripCount(app.labels);
        expect(getTrips).toBe(endpoint === 'machine' ? 2 : 1);
        app.labels.length = 0;
        await search();
        const searchTrips = tripCount(app.labels);
        expect(searchTrips).toBe(endpoint === 'machine' ? 3 : 2);
        const files: MemoryFile[] = [];
        for (let i = 11; i >= 0; i--) {
          const row = await seedFile(app, {
            name: `${String(i).padStart(2, '0')}.pdf`,
          });
          files.push({
            name: row.name,
            mediaType: row.media_type,
            size: row.size,
            sha256: row.sha256,
          });
        }
        files.sort((a, b) => a.name.localeCompare(b.name));
        app.labels.length = 0;
        const current = structured(await get());
        expect(current.files).toEqual(files);
        expect(tripCount(app.labels)).toBe(getTrips);
        app.labels.length = 0;
        const hits = structured(await search()).results as Record<
          string,
          unknown
        >[];
        expect(hits).toHaveLength(1);
        expect(hits[0].files).toEqual(
          files.slice(0, 10).map(({ name, size }) => ({ name, size })),
        );
        expect(hits[0].fileCount).toBe(12);
        expect(tripCount(app.labels)).toBe(searchTrips);
      });
      it('E3: replacing a name appears exactly once in get with only its new digest', async () => {
        const old = await attachFile(app, machine.token);
        const replacement = await attachFile(app, machine.token, {
          bytes: Buffer.from('new MCP-visible digest'),
        });
        expect(replacement).toMatchObject({
          outcome: 'replaced',
          replacedSha256: old.sha256,
        });
        expect(structured(await get()).files).toEqual([
          {
            name: pdfName,
            mediaType: replacement.mediaType,
            size: replacement.size,
            sha256: replacement.sha256,
          },
        ]);
      });
      it('E18: the available-meaning search path projects file metadata inside its existing two batches', async () => {
        await seedMemories(app, [
          memoryFixture(604, {
            bucket: fileBucket,
            content: typicalMemories[0].content,
          }),
        ]);
        if (!app.services)
          throw new Error('The search stand-ins must be installed.');
        app.services.failEmbedding = false;
        const query = () =>
          client.call('search', { bucket: fileBucket, query: 'pnpm verify' });
        app.labels.length = 0;
        const initial = structured(await query());
        expect(initial.meaning).toBe('available');
        const trips = tripCount(app.labels);
        expect(trips).toBe(endpoint === 'machine' ? 3 : 2);
        const row = await seedFile(app, { id: memoryId(604) });
        app.labels.length = 0;
        const hits = structured(await query()).results as Record<
          string,
          unknown
        >[];
        expect(hits.find((hit) => hit.id === memoryId(604))).toMatchObject({
          files: [{ name: row.name, size: row.size }],
          fileCount: 1,
        });
        expect(tripCount(app.labels)).toBe(trips);
      });
      it('E19: inventory is exactly ten tools; get explains byte-free CLI file access and guarded destructive detach', async () => {
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name).sort()).toEqual([
          'create_bucket',
          'delete_bucket',
          'detach',
          'forget',
          'get',
          'list_buckets',
          'list_secrets',
          'remember',
          'search',
          'update',
        ]);
        const description = tools.find(
          (tool) => tool.name === 'get',
        )?.description;
        expect(description).toContain('nook memory attach <id> <path>');
        expect(description).toContain(
          'nook memory download <id> <name> [--output <path>]',
        );
        expect(description).toMatch(/detach.*sha256|sha256.*detach/i);
        const tool = tools.find((entry) => entry.name === 'detach');
        expect(tool?.annotations).toMatchObject({
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
        });
        expect(
          Object.keys(tool?.inputSchema.properties as object).sort(),
        ).toEqual(['id', 'name', 'sha256']);
        expect(tool?.inputSchema.required).toEqual(
          expect.arrayContaining(['id', 'name', 'sha256']),
        );
      });
      it('E19: the deployment MCP inventory matches the real tools/list response', async () => {
        const { tools } = await client.listTools();
        const documentation = await readFile('docs/deployment.md', 'utf8');
        const inventory = /Nook serves[^\n]+/.exec(documentation)?.[0] ?? '';
        const documented = [...inventory.matchAll(/`([a-z_]+)`/g)].map(
          (match) => match[1],
        );
        expect(documented.sort()).toEqual(
          tools.map((tool) => tool.name).sort(),
        );
      });
      it('E20: stale detach preserves all state, current detach removes and audits, and retry is File not found', async () => {
        const attached = await attachFile(app, machine.token);
        const stale = '0'.repeat(64);
        const before = await fileSnapshot(app, ownerHeaders());
        expectToolError(
          await detach(stale),
          `${pdfName} changed: its sha256 is now ${attached.sha256}, not ${stale}. Get the memory again before detaching.`,
        );
        expect(await fileSnapshot(app, ownerHeaders())).toEqual(before);
        const result = await detach(attached.sha256);
        expect(result.isError).not.toBe(true);
        expect(await fileRows(app)).toEqual([]);
        expect(await fileObjects(app)).toEqual([]);
        const after = await auditRows(app);
        expect(after.filter((r) => r.outcome === 'file_detached')).toEqual([
          expect.objectContaining({
            bucket: fileBucket,
            memory_id: fileMemory,
            file_name: pdfName,
            file_sha256: attached.sha256,
            file_size: attached.size,
            machine_id: endpoint === 'machine' ? machine.id : null,
            machine_name: endpoint === 'machine' ? 'LG16' : null,
          }),
        ]);
        expectToolError(await detach(attached.sha256), 'File not found.');
        expect(await auditRows(app)).toEqual(after);
        expectToolError(
          await detach(attached.sha256, 'absent.pdf'),
          'File not found.',
        );
      });
      it('E6/E20: detach rejects dot names and a JSON-preserved lone surrogate without storing or deleting anything', async () => {
        const stored = await attachFile(app, machine.token);
        const before = await fileSnapshot(app, ownerHeaders());
        for (const name of ['.', '..', 'lone\ud800.pdf']) {
          const result = await detach(stored.sha256, name);
          expect(result.isError).toBe(true);
          expect(result.structuredContent).toBeUndefined();
          expect(result.content).toHaveLength(1);
          expect(result.content[0].text).toMatch(
            /file name|filename|Unicode|InvalidFile/i,
          );
        }
        expect(await fileSnapshot(app, ownerHeaders())).toEqual(before);
      });
      it('E18/E20: unreadable files are hidden from get/search/detach, and readable ancestors cannot be detached', async () => {
        const stored = await attachFile(app, machine.token);
        await seedMemories(app, [
          memoryFixture(602, { bucket: 'me' }),
          memoryFixture(603, { bucket: 'personal' }),
        ]);
        const all = await fileMachine(app, ['me', 'personal'], 'seeder');
        const ancestor = await attachFile(app, all.token, {
          id: memoryId(602),
        });
        const privateFile = await attachFile(app, all.token, {
          id: memoryId(603),
          name: 'private-name.pdf',
        });
        const before = await fileSnapshot(app, ownerHeaders());
        const restricted = memoryClient(app, protocol, {
          machine: true,
          headers: { Authorization: `Bearer ${machine.token}` },
        });
        expectToolError(
          await restricted.call('get', { id: memoryId(603) }),
          'Memory not found.',
        );
        expectToolError(
          await restricted.call('search', {
            bucket: 'personal',
            query: 'Attachment',
          }),
          'Access to this bucket is forbidden.',
        );
        expectToolError(
          await restricted.call('detach', {
            id: memoryId(602),
            name: pdfName,
            sha256: ancestor.sha256,
          }),
          'Access to this bucket is forbidden.',
        );
        for (const id of [memoryId(603), randomUUID()])
          expectToolError(
            await restricted.call('detach', {
              id,
              name: privateFile.name,
              sha256: privateFile.sha256,
            }),
            'Memory not found.',
          );
        const other = await fileMachine(app, ['personal'], 'other');
        expectToolError(
          await memoryClient(app, protocol, {
            machine: true,
            headers: { Authorization: `Bearer ${other.token}` },
          }).call('detach', {
            id: fileMemory,
            name: pdfName,
            sha256: stored.sha256,
          }),
          'Memory not found.',
        );
        expect(await fileSnapshot(app, ownerHeaders())).toEqual(before);
      });
      it('E22/E23: stale MCP forget keeps three files; current forget removes each row, object and version with one audit per file', async () => {
        for (const name of ['a.pdf', 'b.pdf', 'c.pdf'])
          await attachFile(app, machine.token, { name });
        expect(
          structured(
            await client.call('update', {
              id: fileMemory,
              expectedVersion: 1,
              content: '# File guide\nA second immutable text version.',
            }),
          ),
        ).toMatchObject({ version: 2, updated: true });
        const db = await app.mf.getD1Database('DB');
        expect(
          (
            await db
              .prepare('SELECT version FROM memory_versions WHERE memory_id=?')
              .bind(fileMemory)
              .all()
          ).results,
        ).toHaveLength(2);
        const before = await fileSnapshot(app, ownerHeaders());
        expectToolError(
          await client.call('forget', { id: fileMemory, expectedVersion: 1 }),
          changedForget(2, 1),
        );
        expect(await fileSnapshot(app, ownerHeaders())).toEqual(before);
        expect(
          (await client.call('forget', { id: fileMemory, expectedVersion: 2 }))
            .isError,
        ).not.toBe(true);
        expect(await fileRows(app)).toEqual([]);
        expect(await fileObjects(app)).toEqual([]);
        expect(
          (
            await db
              .prepare('SELECT * FROM memory_versions WHERE memory_id=?')
              .bind(fileMemory)
              .all()
          ).results,
        ).toEqual([]);
        expect(
          (await auditRows(app))
            .filter((r) => r.outcome === 'file_forgotten')
            .map((r) => r.file_name)
            .sort(),
        ).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
        for (const entry of (await auditRows(app)).filter(
          (row) => row.outcome === 'file_forgotten',
        ))
          expect(entry).toMatchObject({
            machine_id: endpoint === 'machine' ? machine.id : null,
            machine_name: endpoint === 'machine' ? 'LG16' : null,
          });
        expectToolError(await get(), 'Memory not found.');
        for (const name of ['a.pdf', 'b.pdf', 'c.pdf']) {
          const response = await downloadFile(
            app,
            machine.token,
            fileMemory,
            name,
          );
          expect(response.status).toBe(404);
          expect(await response.json()).toEqual({
            _tag: 'MemoryNotFound',
            message: 'Memory not found.',
          });
        }
      });
      it('E21: successful attach/download/replace/detach/forget and their errors never disclose the file canary', async () => {
        const canary = `private-attachment-${randomUUID()}-${randomUUID()}`;
        const logs: string[] = [];
        const outputs: string[] = [];
        class FileLog extends Log {
          override log(message: string) {
            logs.push(message);
          }
        }
        await app.setBindings(app.bindings, {
          log: new FileLog(LogLevel.VERBOSE),
          handleRuntimeStdio(stdout, stderr) {
            for (const stream of [stdout, stderr])
              stream.on('data', (chunk) => logs.push(chunk.toString()));
          },
        });
        let transitions = 0;
        const check = () =>
          expectNoValue(
            [...outputs, ...logs, JSON.stringify(auditRowsCache)].join('\n'),
            [canary, `${canary}-replacement`],
          );
        let auditRowsCache: unknown[] = [];
        try {
          const bytes = Buffer.from(canary);
          const stored = await attachFile(app, machine.token, { bytes });
          transitions++;
          outputs.push(
            JSON.stringify(stored),
            JSON.stringify(await get()),
            JSON.stringify(await search()),
          );
          const keyring = await privateKeyring();
          let replacement: AttachedFile;
          try {
            await configureFilesCli(keyring, app.origin, machine.token);
            const input = resolve(keyring.home, 'input');
            await mkdir(input);
            const path = resolve(input, pdfName);
            await writeFile(path, bytes);
            const retry = await keyring.start([
              'memory',
              'attach',
              fileMemory,
              path,
            ]).done;
            outputs.push(retry.stdout, retry.stderr);
            check();
            expect(retry.status).toBe(0);
            expect(JSON.parse(retry.stdout).outcome).toBe('unchanged');
            const result = await keyring.start([
              'memory',
              'download',
              fileMemory,
              pdfName,
            ]).done;
            outputs.push(result.stdout, result.stderr);
            expectNoValue(result.stdout + result.stderr, [canary]);
            expect(result.status).toBe(0);
            transitions++;
            await writeFile(path, Buffer.from(`${canary}-replacement`));
            const replaced = await keyring.start([
              'memory',
              'attach',
              fileMemory,
              path,
            ]).done;
            outputs.push(replaced.stdout, replaced.stderr);
            check();
            expect(replaced.status).toBe(0);
            replacement = JSON.parse(replaced.stdout) as AttachedFile;
            expect(replacement.outcome).toBe('replaced');
            transitions++;
          } finally {
            await keyring.close();
          }
          outputs.push(
            JSON.stringify(replacement),
            JSON.stringify(await detach(stored.sha256)),
          );
          const removed = await detach(replacement.sha256);
          outputs.push(JSON.stringify(removed));
          expect(removed.isError).not.toBe(true);
          transitions++;
          outputs.push(JSON.stringify(await detach(replacement.sha256)));
          await attachFile(app, machine.token, { bytes });
          const forgotten = await client.call('forget', {
            id: fileMemory,
            expectedVersion: 1,
          });
          outputs.push(JSON.stringify(forgotten));
          expect(forgotten.isError).not.toBe(true);
          transitions++;
          const missing = await downloadFile(app, machine.token);
          outputs.push(await missing.text());
          const auditResponse = await fetch(`${app.origin}/api/audit`, {
            headers: ownerHeaders(),
          });
          expect(auditResponse.status).toBe(200);
          outputs.push(await auditResponse.text());
          auditRowsCache = await auditRows(app);
          expect(
            transitions,
            'The canary traverses every required successful operation',
          ).toBe(5);
          expect(await fileObjects(app)).toEqual([]);
        } finally {
          auditRowsCache = await auditRows(app);
          check();
        }
      });
    });
  },
);
