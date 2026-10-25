import { createHash, randomUUID } from 'node:crypto';
import type { MemoryClient, Principal } from '@nook/contract';
import { expect } from 'vitest';
import { auditRows } from './audit.ts';
import { seedGrantTree } from './grants.ts';
import {
  memoryFixture,
  memoryId,
  seedMemories,
  seedMemoryMachine,
} from './memory.ts';
import type { TestRuntime } from './runtime.ts';

// Local contract shapes keep acceptance tests compilable before implementation.
export type MemoryFile = {
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
};
export type AttachedFile = MemoryFile & {
  id: string;
  bucket: string;
  outcome: 'created' | 'unchanged' | 'replaced';
  replacedSha256: string | null;
};
export type FileRow = {
  memory_id: string;
  name: string;
  object_key: string;
  media_type: string;
  size: number;
  sha256: string;
  principal: string;
  machine_id: string | null;
  machine_name: string | null;
  client_name: string;
  client_version: string | null;
  attached_at: string;
};
export const fileBucket = 'work/mamasan';
export const fileMemory = memoryId(601);
export const pdfName = 'R4 CONECTA V3.0 (006).pdf';
export const maximumFile = 26_214_400;
export const maximumBucket = 1_073_741_824;
export const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
export const filePath = (id = fileMemory, name = pdfName, machine = true) =>
  `/api/${machine ? 'machine/' : ''}memories/${id}/files/${encodeURIComponent(name)}`;
export async function seedFileMemory(
  app: TestRuntime,
  memory = memoryFixture(601, {
    bucket: fileBucket,
    content: '# File guide\nAttachment acceptance fixture.',
  }),
) {
  await seedGrantTree(app, [
    'me',
    'personal',
    'work',
    'work/acme',
    fileBucket,
    `${fileBucket}/api`,
    'work/mamasan-old',
  ]);
  await seedMemories(app, [memory]);
  return fileMachine(app);
}
export async function fileMachine(
  app: TestRuntime,
  grant: string[] = [fileBucket],
  name = 'LG16',
) {
  const machine = await seedMemoryMachine(app, grant);
  await (await app.mf.getD1Database('DB'))
    .prepare('UPDATE machine_tokens SET machine_name=? WHERE id=?')
    .bind(name, machine.id)
    .run();
  return { ...machine, name };
}
export function putFile(
  app: TestRuntime,
  token: string,
  options: {
    id?: string;
    name?: string;
    bytes?: Uint8Array;
    mediaType?: string;
    headers?: HeadersInit;
  } = {},
) {
  const headers = new Headers({
    Authorization: `Bearer ${token}`,
    'Content-Type': options.mediaType ?? 'application/pdf',
    'User-Agent': 'nook-acceptance/1.0',
  });
  for (const [name, value] of new Headers(options.headers))
    headers.set(name, value);
  return fetch(app.origin + filePath(options.id, options.name), {
    method: 'PUT',
    headers,
    body: Buffer.from(options.bytes ?? Buffer.from('synthetic file bytes')),
  });
}
export async function attachFile(
  app: TestRuntime,
  token: string,
  options: Parameters<typeof putFile>[2] = {},
) {
  const response = await putFile(app, token, options);
  expect(
    response.status,
    'The built Worker implements the file upload route',
  ).toBe(200);
  return (await response.json()) as AttachedFile;
}
export function downloadFile(
  app: TestRuntime,
  token: string,
  id = fileMemory,
  name = pdfName,
) {
  return fetch(app.origin + filePath(id, name), {
    headers: { Authorization: `Bearer ${token}` },
  });
}
export async function fileRows(app: TestRuntime) {
  return (
    await (
      await app.mf.getD1Database('DB')
    )
      .prepare('SELECT * FROM memory_files ORDER BY memory_id,name')
      .all<FileRow>()
  ).results;
}
export async function fileObjects(app: TestRuntime) {
  const bucket = await app.mf.getR2Bucket('FILES');
  const objects = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: 'files/', cursor });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}
// Reuse a running Worker only in suites without schema or checkpoint changes.
// Every example starts with fresh file/memory state and new machine tokens.
export async function clearFileState(app: TestRuntime) {
  const db = await app.mf.getD1Database('DB');
  await db.batch(
    [
      'memory_files',
      'memories',
      'machine_tokens',
      'audit_entries',
      'memory_vector_removals',
    ].map((table) => db.prepare(`DELETE FROM ${table}`)),
  );
  const keys = (await fileObjects(app)).map((object) => object.key);
  if (keys.length) await (await app.mf.getR2Bucket('FILES')).delete(keys);
}
export async function fileSnapshot(
  app: TestRuntime,
  headers: HeadersInit = {},
) {
  const response = await fetch(`${app.origin}/api/audit`, { headers });
  expect(
    response.status,
    'The owner Audit API decodes current file outcomes',
  ).toBe(200);
  return {
    files: await fileRows(app),
    objects: (await fileObjects(app)).map((o) => o.key).sort(),
    audit: await auditRows(app),
    publicAudit: (await response.json()).entries as Record<string, unknown>[],
  };
}
export function expectAuditFacts(
  entry: unknown,
  facts: Record<string, unknown>,
) {
  expect(entry).toMatchObject({ outcome: facts.outcome, bucket: facts.bucket });
  // Public field nesting is not fixed by the accepted spec; every stated fact
  // must nevertheless reach the owner, while D1 column assertions pin storage.
  const values = (value: unknown): unknown[] =>
    value && typeof value === 'object'
      ? Object.values(value).flatMap(values)
      : [value];
  for (const value of Object.values(facts))
    expect(values(entry)).toContain(value);
}
export async function seedFile(
  app: TestRuntime,
  options: {
    id?: string;
    name?: string;
    size?: number;
    bytes?: Uint8Array;
    attachedAt?: string;
    object?: boolean;
    mediaType?: string;
    principal?: Principal;
    client?: MemoryClient;
  } = {},
) {
  const bytes = options.bytes ?? Buffer.from('seeded attachment');
  const principal = options.principal ?? {
    kind: 'machine',
    id: 'synthetic-lg16',
    name: 'LG16',
  };
  const client = options.client ?? { name: 'nook-acceptance', version: '1.0' };
  const row: FileRow = {
    memory_id: options.id ?? fileMemory,
    name: options.name ?? pdfName,
    object_key: `files/${randomUUID()}`,
    media_type: options.mediaType ?? 'application/pdf',
    size: options.size ?? bytes.byteLength,
    sha256: digest(bytes),
    principal: principal.kind,
    machine_id: principal.kind === 'machine' ? principal.id : null,
    machine_name: principal.kind === 'machine' ? principal.name : null,
    client_name: client.name,
    client_version: client.version,
    attached_at: options.attachedAt ?? '2026-10-22T14:00:00.000Z',
  };
  // Missing schema is an intended red, never silently install feature tables here.
  await (await app.mf.getD1Database('DB'))
    .prepare(
      'INSERT INTO memory_files(memory_id,name,object_key,media_type,size,sha256,principal,machine_id,machine_name,client_name,client_version,attached_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .bind(...Object.values(row))
    .run();
  if (options.object !== false)
    await (await app.mf.getR2Bucket('FILES')).put(row.object_key, bytes);
  return row;
}
export async function seedUsage(app: TestRuntime, total: number) {
  for (let index = 0, remaining = total; remaining > 0; index++) {
    const size = Math.min(remaining, maximumFile);
    await seedFile(app, { name: `quota-${index}.bin`, size, object: false });
    remaining -= size;
  }
}
export async function expectHttpError(
  response: Response,
  status: number,
  tag: string,
  message?: string,
) {
  expect(response.status).toBe(status);
  expect(
    response.headers.get('Content-Type') ?? '',
    'File API errors use the contract JSON shape',
  ).toContain('application/json');
  const body = await response.json();
  if (message === undefined) expect(body).toMatchObject({ _tag: tag });
  else expect(body).toEqual({ _tag: tag, message });
}
