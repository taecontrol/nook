import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { access, accessFixture } from './support/access.ts';
import { auditRows } from './support/audit.ts';
import {
  memoryClient,
  memoryFixture,
  memoryId,
  seedMemories,
} from './support/memory.ts';
import {
  attachFile,
  digest,
  downloadFile,
  expectAuditFacts,
  expectHttpError,
  fileBucket,
  fileMachine,
  fileMemory,
  fileObjects,
  filePath,
  fileRows,
  fileSnapshot,
  maximumBucket,
  maximumFile,
  pdfName,
  putFile,
  seedFile,
  seedFileMemory,
  seedUsage,
} from './support/memory-files.ts';
import {
  type FilesRuntime,
  filesRuntime,
} from './support/memory-files-runtime.ts';
import { changedForget } from './support/memory-forget.ts';
import { runtime } from './support/runtime.ts';

let app: FilesRuntime;
let machine: Awaited<ReturnType<typeof fileMachine>>;
beforeEach(async () => {
  app = await filesRuntime();
  machine = await seedFileMemory(app);
});
afterEach(() => app?.close());

it('E1: attach returns exact metadata, preserves the text head and records authenticated provenance', async () => {
  const bytes = Buffer.alloc(2_418_734, 67);
  const db = await app.mf.getD1Database('DB');
  const before = await db
    .prepare('SELECT * FROM memories WHERE id=?')
    .bind(fileMemory)
    .first();
  expect(await attachFile(app, machine.token, { bytes })).toEqual({
    id: fileMemory,
    bucket: fileBucket,
    name: pdfName,
    mediaType: 'application/pdf',
    size: bytes.length,
    sha256: digest(bytes),
    outcome: 'created',
    replacedSha256: null,
  });
  expect(
    await db
      .prepare('SELECT * FROM memories WHERE id=?')
      .bind(fileMemory)
      .first(),
  ).toEqual(before);
  expect(await auditRows(app)).toEqual([
    expect.objectContaining({
      outcome: 'file_attached',
      bucket: fileBucket,
      memory_id: fileMemory,
      file_name: pdfName,
      file_size: bytes.length,
      file_sha256: digest(bytes),
      replaced_sha256: null,
      machine_id: machine.id,
      machine_name: 'LG16',
      client_name: 'nook-acceptance',
      client_version: '1.0',
    }),
  ]);
  expect(await fileObjects(app)).toHaveLength(1);
  expectAuditFacts((await fileSnapshot(app)).publicAudit[0], {
    outcome: 'file_attached',
    bucket: fileBucket,
    memoryId: fileMemory,
    name: pdfName,
    size: bytes.length,
    sha256: digest(bytes),
    machineId: machine.id,
    machineName: 'LG16',
    client: 'nook-acceptance',
  });
});
it('E2: a lost-response retry is unchanged with no audit, object or provenance write', async () => {
  const initial = await attachFile(app, machine.token);
  const before = await fileSnapshot(app);
  expect(
    await attachFile(app, machine.token, {
      headers: { 'User-Agent': 'different-client/2.0' },
    }),
  ).toEqual({ ...initial, outcome: 'unchanged' });
  expect(await fileSnapshot(app)).toEqual(before);
});
it('E3: replacement publishes one new digest, removes the old key and audits both digests', async () => {
  const old = await attachFile(app, machine.token);
  const [previous] = await fileRows(app);
  const bytes = Buffer.from('replacement bytes');
  expect(await attachFile(app, machine.token, { bytes })).toEqual({
    ...old,
    size: bytes.length,
    sha256: digest(bytes),
    outcome: 'replaced',
    replacedSha256: old.sha256,
  });
  const current = await fileRows(app);
  expect(current).toHaveLength(1);
  expect(current[0].sha256).toBe(digest(bytes));
  expect(current[0].object_key).not.toBe(previous.object_key);
  expect(
    await (await app.mf.getR2Bucket('FILES')).get(previous.object_key),
  ).toBeNull();
  expect(await fileObjects(app)).toHaveLength(1);
  expect(
    (await auditRows(app)).find((r) => r.outcome === 'file_replaced'),
  ).toMatchObject({ file_sha256: digest(bytes), replaced_sha256: old.sha256 });
});
it('E4: the Worker rejects an oversized declared body before reading it and requires Content-Length', async () => {
  async function headersOnly(length?: number) {
    return new Promise<{ status: number; body: string }>((accept, reject) => {
      const input = request(
        app.origin + filePath(),
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${machine.token}`,
            'Content-Type': 'application/pdf',
            ...(length === undefined
              ? { 'Transfer-Encoding': 'chunked' }
              : { 'Content-Length': String(length) }),
          },
        },
        (response) => {
          let body = '';
          response.on('data', (part) => {
            body += part;
          });
          response.on('end', () => {
            accept({ status: response.statusCode ?? 0, body });
            input.destroy();
          });
        },
      );
      input.on('error', reject);
      input.setTimeout(3000, () =>
        input.destroy(
          new Error(
            'The size gate buffered a body instead of rejecting its headers.',
          ),
        ),
      );
      input.flushHeaders();
    });
  }
  const large = await headersOnly(maximumFile + 1);
  expect(large.status).toBe(413);
  expect(JSON.parse(large.body)).toMatchObject({ _tag: 'FileTooLarge' });
  expect((await headersOnly()).status).toBe(411);
  expect(await fileObjects(app)).toEqual([]);
  expect(await auditRows(app)).toEqual([]);
});
it('E4: the production Worker round-trips exactly 25 MiB with its declared length and digest', async () => {
  const bytes = Buffer.alloc(maximumFile, 113);
  const stored = await attachFile(app, machine.token, { bytes });
  expect(stored.size).toBe(maximumFile);
  expect(stored.sha256).toBe(digest(bytes));
  const response = await downloadFile(app, machine.token);
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Length')).toBe(String(maximumFile));
  expect(response.headers.get('X-Nook-Sha256')).toBe(stored.sha256);
  const downloaded = new Uint8Array(await response.arrayBuffer());
  expect(downloaded.byteLength).toBe(maximumFile);
  expect(digest(downloaded)).toBe(stored.sha256);
  expect(await fileObjects(app)).toHaveLength(1);
});
it('E5: metadata-only quota counts the replaced size once and leaves failed uploads unstored', async () => {
  await seedUsage(app, maximumBucket - 100);
  const before = await fileSnapshot(app);
  await expectHttpError(
    await putFile(app, machine.token, {
      name: 'quota.bin',
      bytes: Buffer.alloc(101),
    }),
    409,
    'FileQuotaExceeded',
    `${fileBucket} files use 1,073,741,724 of 1,073,741,824 bytes; quota.bin needs 101.`,
  );
  expect(await fileSnapshot(app)).toEqual(before);
  const old = await attachFile(app, machine.token, {
    name: 'at-limit.bin',
    bytes: Buffer.alloc(100),
  });
  const smaller = await attachFile(app, machine.token, {
    name: old.name,
    bytes: Buffer.alloc(99, 1),
  });
  expect(smaller).toMatchObject({
    outcome: 'replaced',
    size: 99,
    replacedSha256: old.sha256,
  });
  expect((await fileRows(app)).reduce((sum, row) => sum + row.size, 0)).toBe(
    maximumBucket - 1,
  );
});
it('E6: 255 UTF-8 bytes, byte-exact Unicode names and empty files round trip', async () => {
  const names = [
    `${'é'.repeat(125)}a.pdf`,
    'é.pdf',
    'e\u0301.pdf',
    'Guide.pdf',
    'guide.pdf',
    'empty.bin',
  ];
  expect(Buffer.byteLength(names[0])).toBe(255);
  for (const name of names) {
    const bytes = name === 'empty.bin' ? Buffer.alloc(0) : Buffer.from(name);
    const stored = await attachFile(app, machine.token, { name, bytes });
    expect(stored.name).toBe(name);
    const response = await downloadFile(app, machine.token, fileMemory, name);
    expect(response.status).toBe(200);
    expect(digest(new Uint8Array(await response.arrayBuffer()))).toBe(
      digest(bytes),
    );
  }
  expect(await fileRows(app)).toHaveLength(names.length);
});
it.each([
  `${'a'.repeat(252)}.pdf`,
  `${'界'.repeat(90)}.pdf`,
  `${'a'.repeat(1000)}.pdf`,
  'a/b.pdf',
  'a\\b.pdf',
  'nul\0.pdf',
  'c0\u001f.pdf',
  'c1\u0085.pdf',
  'del\u007f.pdf',
])(
  'E6: the HTTP boundary refuses invalid name %j with InvalidFile and stores nothing',
  async (name) => {
    // The name gate rejects before reading a body; keep this input path-only.
    await expectHttpError(
      await putFile(app, machine.token, { name, bytes: Buffer.alloc(0) }),
      400,
      'InvalidFile',
    );
    expect(await fileRows(app)).toEqual([]);
    expect(await fileObjects(app)).toEqual([]);
    expect(await auditRows(app)).toEqual([]);
  },
);
it('E11: attach denies readable ancestors and masks unreadable and missing memories without side effects', async () => {
  await seedMemories(app, [
    memoryFixture(602, { bucket: 'me' }),
    memoryFixture(603, { bucket: 'personal' }),
  ]);
  await expectHttpError(
    await putFile(app, machine.token, { id: memoryId(602) }),
    403,
    'Forbidden',
  );
  const other = await fileMachine(app, ['personal'], 'other');
  for (const id of [fileMemory, randomUUID()])
    await expectHttpError(
      await putFile(app, other.token, { id }),
      404,
      'MemoryNotFound',
      'Memory not found.',
    );
  expect(await fileRows(app)).toEqual([]);
  expect(await fileObjects(app)).toEqual([]);
  expect(await auditRows(app)).toEqual([]);
});
it('E6: a percent-encoded lone surrogate is refused as InvalidFile and stores no bytes', async () => {
  const path = filePath(fileMemory, 'surrogate.pdf').replace(
    'surrogate.pdf',
    '%ED%A0%80.pdf',
  );
  await expectHttpError(
    await fetch(app.origin + path, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${machine.token}`,
        'Content-Type': 'application/pdf',
      },
      body: Buffer.alloc(0),
    }),
    400,
    'InvalidFile',
  );
  expect(await fileObjects(app)).toEqual([]);
  expect(await auditRows(app)).toEqual([]);
});
it('E6: every C0/C1 control byte in a name, including an encoded slash, is InvalidFile without stored state', async () => {
  for (const code of [
    ...Array.from({ length: 32 }, (_, i) => i),
    ...Array.from({ length: 33 }, (_, i) => i + 127),
  ]) {
    try {
      await expectHttpError(
        await putFile(app, machine.token, {
          name: `control-${String.fromCharCode(code)}.pdf`,
          bytes: Buffer.alloc(0),
        }),
        400,
        'InvalidFile',
      );
    } catch (error) {
      // CI diagnostic: print before the shard can exhaust its job deadline.
      console.error(
        `E6 control U+${code.toString(16).padStart(4, '0')}`,
        error,
      );
      throw error;
    }
  }
  await expectHttpError(
    await putFile(app, machine.token, {
      name: 'encoded/slash.pdf',
      bytes: Buffer.alloc(0),
    }),
    400,
    'InvalidFile',
  );
  expect(await fileRows(app)).toEqual([]);
  expect(await fileObjects(app)).toEqual([]);
  expect(await auditRows(app)).toEqual([]);
});
it('E14: downloads allow canRead ancestors and me, and mask unreadable memories exactly like absent ones', async () => {
  await seedMemories(app, [
    memoryFixture(602, { bucket: 'work' }),
    memoryFixture(603, { bucket: 'me' }),
  ]);
  const ownerMachine = await fileMachine(app, ['work', 'me'], 'seeder');
  for (const id of [fileMemory, memoryId(602), memoryId(603)])
    await attachFile(app, ownerMachine.token, { id });
  for (const id of [memoryId(602), memoryId(603)]) {
    const response = await downloadFile(app, machine.token, id);
    expect(response.status).toBe(200);
    await response.body?.cancel();
  }
  const before = await auditRows(app);
  const other = await fileMachine(app, ['personal'], 'other');
  for (const id of [fileMemory, randomUUID()])
    await expectHttpError(
      await downloadFile(app, other.token, id),
      404,
      'MemoryNotFound',
      'Memory not found.',
    );
  expect(await auditRows(app)).toEqual(before);
});
it('E17: a missing name is 404; a referenced missing R2 object is 503 and preserves its row', async () => {
  await expectHttpError(
    await downloadFile(app, machine.token, fileMemory, 'missing.pdf'),
    404,
    'FileNotFound',
    'File not found.',
  );
  await attachFile(app, machine.token);
  const before = await fileSnapshot(app);
  await (await app.mf.getR2Bucket('FILES')).delete(before.files[0].object_key);
  await expectHttpError(
    await downloadFile(app, machine.token),
    503,
    'ServiceUnavailable',
  );
  expect(await fileRows(app)).toEqual(before.files);
  expect(await auditRows(app)).toEqual(before.audit);
});
it('E22: owner forget removes three files, versions and objects atomically, audits each, and permits bucket deletion', async () => {
  for (const name of ['a.pdf', 'b.pdf', 'c.pdf'])
    await attachFile(app, machine.token, { name });
  expect(
    (
      await memoryClient(app, '2026-07-28').call('update', {
        id: fileMemory,
        expectedVersion: 1,
        content: '# File guide\nA second immutable text version.',
      })
    ).structuredContent,
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
  app.labels.length = 0;
  const response = await fetch(
    `${app.origin}/api/memories/${fileMemory}?expectedVersion=2`,
    { method: 'DELETE' },
  );
  expect(response.status).toBe(204);
  expect(app.labels.filter((label) => label === '/after-batch')).toHaveLength(
    1,
  );
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
  for (const name of ['a.pdf', 'b.pdf', 'c.pdf'])
    await expectHttpError(
      await downloadFile(app, machine.token, fileMemory, name),
      404,
      'MemoryNotFound',
      'Memory not found.',
    );
  expect(
    (
      await fetch(
        `${app.origin}/api/buckets/${encodeURIComponent(`${fileBucket}/api`)}`,
        { method: 'DELETE' },
      )
    ).status,
  ).toBe(204);
  expect(
    (
      await fetch(
        `${app.origin}/api/buckets/${encodeURIComponent(fileBucket)}`,
        { method: 'DELETE' },
      )
    ).status,
  ).toBe(204);
});
it('E23: stale owner forget retains all files, objects, versions and audit facts', async () => {
  await attachFile(app, machine.token);
  expect(
    (
      await memoryClient(app, '2026-07-28').call('update', {
        id: fileMemory,
        expectedVersion: 1,
        content: '# File guide\nChanged by another writer.',
      })
    ).structuredContent,
  ).toMatchObject({ version: 2 });
  const before = await fileSnapshot(app);
  await expectHttpError(
    await fetch(`${app.origin}/api/memories/${fileMemory}?expectedVersion=1`, {
      method: 'DELETE',
    }),
    409,
    'MemoryChanged',
    changedForget(2, 1),
  );
  expect(await fileSnapshot(app)).toEqual(before);
});
it('E26: owner HTML downloads use attachment security headers and HEAD never audits either route', async () => {
  const name = 'guía de integración.html';
  const bytes = Buffer.from(
    '<script>globalThis.nookFileExecuted = true</script>',
  );
  const stored = await attachFile(app, machine.token, {
    name,
    bytes,
    mediaType: 'text/html',
  });
  const response = await fetch(app.origin + filePath(fileMemory, name, false));
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
  expect(response.headers.get('Content-Disposition')).toMatch(
    /^attachment(?:;|$)/,
  );
  expect(response.headers.get('Content-Disposition')).toContain(
    `filename*=UTF-8''${encodeURIComponent(name)}`,
  );
  for (const [key, value] of Object.entries({
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox',
    'Cache-Control': 'no-store',
    'X-Nook-Sha256': stored.sha256,
    'Content-Length': String(bytes.length),
  }))
    expect(response.headers.get(key)).toBe(value);
  expect(digest(new Uint8Array(await response.arrayBuffer()))).toBe(
    stored.sha256,
  );
  const before = await auditRows(app);
  for (const machineRoute of [false, true]) {
    const head = await fetch(
      app.origin + filePath(fileMemory, name, machineRoute),
      {
        method: 'HEAD',
        headers: machineRoute
          ? { Authorization: `Bearer ${machine.token}` }
          : {},
      },
    );
    expect(head.status).toBe(405);
    expect(await head.text()).toBe('');
  }
  expect(await auditRows(app)).toEqual(before);
});
it('E26: Bearer cannot authenticate owner downloads and Access cannot authenticate machine upload or download', async () => {
  const issuer = await accessFixture();
  const secured = await runtime({
    bindings: access,
    outboundService: issuer.outboundService,
    r2Buckets: ['FILES'],
  });
  try {
    const headers = { 'Cf-Access-Jwt-Assertion': await issuer.assertion() };
    expect(
      (
        await fetch(secured.origin + filePath(fileMemory, pdfName, false), {
          headers: { Authorization: `Bearer ${machine.token}` },
        })
      ).status,
    ).toBe(401);
    for (const method of ['GET', 'PUT'])
      expect(
        (
          await fetch(secured.origin + filePath(), {
            method,
            headers,
            ...(method === 'PUT' ? { body: Buffer.alloc(0) } : {}),
          })
        ).status,
      ).toBe(401);
    expect(await auditRows(secured)).toEqual([]);
  } finally {
    await secured.close();
  }
});
it('E14/E26: the owner download store masks an existing file outside its caller grant without audit or bytes', async () => {
  const restricted = await filesRuntime({ principalGrant: ['personal'] });
  try {
    await seedFileMemory(restricted);
    await seedFile(restricted);
    await expectHttpError(
      await fetch(restricted.origin + filePath(fileMemory, pdfName, false)),
      404,
      'MemoryNotFound',
      'Memory not found.',
    );
    expect(await auditRows(restricted)).toEqual([]);
    expect(await fileObjects(restricted)).toHaveLength(1);
  } finally {
    await restricted.close();
  }
});
it('E11/E26: revoked machine credentials are rejected before file storage', async () => {
  await (await app.mf.getD1Database('DB'))
    .prepare('DELETE FROM machine_tokens WHERE id=?')
    .bind(machine.id)
    .run();
  await expectHttpError(
    await putFile(app, machine.token, { bytes: Buffer.alloc(0) }),
    401,
    'Unauthorized',
  );
  await expectHttpError(
    await downloadFile(app, machine.token),
    401,
    'Unauthorized',
  );
  expect(await auditRows(app)).toEqual([]);
  expect(await fileObjects(app)).toEqual([]);
});
