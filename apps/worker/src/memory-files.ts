import { D1Client } from '@effect/sql-d1';
import {
  type BucketGrant,
  type Detached,
  type DetachFile,
  type FileAttached,
  FileChanged,
  FileNotFound,
  FileQuotaExceeded,
  FileTooLarge,
  fileLimits,
  InvalidFile,
  isFileDigest,
  validateFileName,
  validateFileSize,
  validateMediaType,
} from '@nook/contract';
import { Effect } from 'effect';
import { HttpApiError } from 'effect/http-api';
import type { Fragment } from 'effect/sql/Statement';
import { type FileActor, fileAuditInsert } from './audit.ts';
import { type FileBindings, fileNow, fileObjects } from './file-objects.ts';
import { unavailable } from './http-errors.ts';
import { bucketFor, memoryNotFound } from './memory-access.ts';

const publishWindowMs = 10 * 60 * 1000;
const fileNotFound = () => new FileNotFound({ message: 'File not found.' });
type FileRow = {
  name: string;
  object_key: string;
  media_type: string;
  size: number;
  sha256: string;
};
type FileState = {
  id: string | null;
  name: string | null;
  object_key: string | null;
  media_type: string | null;
  size: number | null;
  sha256: string | null;
  usage: number;
};
type Upload = {
  id: string;
  name: string;
  mediaType: string;
  bytes: Uint8Array;
};
function validName(name: string) {
  const message = validateFileName(name);
  return message ? Effect.fail(new InvalidFile({ message })) : Effect.void;
}
function validUpload(
  input: Upload,
): Effect.Effect<void, InvalidFile | FileTooLarge> {
  const message =
    validateFileName(input.name) ?? validateMediaType(input.mediaType);
  if (message) return Effect.fail(new InvalidFile({ message }));
  const sizeMessage = validateFileSize(input.bytes.byteLength);
  return sizeMessage
    ? Effect.fail(new FileTooLarge({ message: sizeMessage }))
    : Effect.void;
}
function quotaExceeded(state: FileState, size: number) {
  return state.usage - (state.size ?? 0) + size > fileLimits.bucketBytes;
}
function quotaError(bucket: string, name: string, usage: number, size: number) {
  const format = (number: number) => number.toLocaleString('en-US');
  return new FileQuotaExceeded({
    message: `${bucket} files use ${format(usage)} of ${format(fileLimits.bucketBytes)} bytes; ${name} needs ${format(size)}.`,
  });
}
function attached(
  id: string,
  bucket: string,
  file: FileRow,
  outcome: FileAttached['outcome'],
  replacedSha256: string | null = null,
): FileAttached {
  return {
    id,
    bucket,
    name: file.name,
    mediaType: file.media_type,
    size: file.size,
    sha256: file.sha256,
    outcome,
    replacedSha256,
  };
}
function requireFile(
  state: FileState | undefined,
): Effect.Effect<
  FileState & FileRow,
  | HttpApiError.ServiceUnavailable
  | FileNotFound
  | ReturnType<typeof memoryNotFound>
> {
  if (!state) return Effect.fail(new HttpApiError.ServiceUnavailable());
  if (!state.id) return Effect.fail(memoryNotFound());
  if (!state.object_key) return Effect.fail(fileNotFound());
  return Effect.succeed(state as FileState & FileRow);
}
function notPublished(
  state: FileState | undefined,
  input: Upload,
  bucket: string,
  sha256: string,
): Effect.Effect<
  FileAttached,
  | ReturnType<typeof memoryNotFound>
  | FileQuotaExceeded
  | HttpApiError.ServiceUnavailable
> {
  if (!state) return Effect.fail(new HttpApiError.ServiceUnavailable());
  if (!state.id) return Effect.fail(memoryNotFound());
  if (state.sha256 === sha256)
    return Effect.succeed(
      attached(input.id, bucket, state as FileState & FileRow, 'unchanged'),
    );
  if (quotaExceeded(state, input.bytes.byteLength))
    return Effect.fail(
      quotaError(bucket, input.name, state.usage, input.bytes.byteLength),
    );
  return Effect.fail(new HttpApiError.ServiceUnavailable());
}

// Project the complete detail in the existing memory SELECT, never a new trip.
export function filesFor(sql: D1Client.D1Client, id: Fragment) {
  return sql`(SELECT json_group_array(json_object('name',name,'mediaType',media_type,'size',size,'sha256',sha256,'attachedAt',attached_at,'principal',json(CASE WHEN principal='machine' THEN json_object('kind','machine','id',machine_id,'name',machine_name) ELSE json_object('kind','owner') END),'client',json_object('name',client_name,'version',client_version))) FROM (SELECT * FROM memory_files WHERE memory_id=${id} ORDER BY name))`;
}
export function searchFilesFor(sql: D1Client.D1Client, id: Fragment) {
  return sql`(SELECT json_group_array(json_object('name',name,'size',size)) FROM (SELECT name,size FROM memory_files WHERE memory_id=${id} ORDER BY name LIMIT 10)) AS files, (SELECT count(*) FROM memory_files WHERE memory_id=${id}) AS fileCount`;
}
export function forgetFileStatements(
  sql: D1Client.D1Client,
  guard: Fragment,
  actor: FileActor,
) {
  const matching = sql`EXISTS (SELECT 1 FROM memories WHERE ${guard} AND memories.id=memory_files.memory_id)`;
  return [
    fileAuditInsert(
      sql,
      actor,
      sql`SELECT 'file_forgotten' AS outcome,(SELECT bucket FROM memories WHERE id=memory_id) AS bucket,memory_id,name,size,sha256,NULL AS replaced_sha256 FROM memory_files WHERE ${matching}`,
    ),
    sql<{
      object_key: string;
    }>`DELETE FROM memory_files WHERE ${matching} RETURNING object_key`,
  ] as const;
}
function cancelled(body: ReadableStream<Uint8Array>) {
  return Effect.promise(() => body.cancel().catch(() => undefined));
}

export const memoryFiles = (grant: BucketGrant, bindings: FileBindings = {}) =>
  Effect.gen(function* () {
    const sql = yield* D1Client.D1Client;
    const objects = fileObjects(bindings);
    const authorize = (id: string, write = false) =>
      bucketFor(grant, id, write).pipe(
        Effect.provideService(D1Client.D1Client, sql),
      );
    const remove = (keys: readonly string[]) =>
      objects.remove(keys).pipe(Effect.catchCause(() => Effect.void));
    const state = (id: string, bucket: string, name: string) =>
      sql<FileState>`SELECT m.id,f.name,f.object_key,f.media_type,f.size,f.sha256, (SELECT COALESCE(sum(u.size),0) FROM memory_files u JOIN memories h ON h.id=u.memory_id WHERE h.bucket=${bucket}) AS usage FROM (SELECT 1) LEFT JOIN memories m ON m.id=${id} AND m.bucket=${bucket} LEFT JOIN memory_files f ON f.memory_id=m.id AND f.name=${name}`;
    const read = (id: string, bucket: string, name: string) =>
      state(id, bucket, name).pipe(
        unavailable,
        Effect.flatMap((rows) => requireFile(rows[0])),
      );
    const deliver = (
      actor: FileActor,
      id: string,
      bucket: string,
      name: string,
      row: FileRow,
      retries: number,
    ): Effect.Effect<
      { file: FileRow; body: ReadableStream<Uint8Array> },
      | HttpApiError.ServiceUnavailable
      | FileNotFound
      | ReturnType<typeof memoryNotFound>
    > =>
      Effect.gen(function* () {
        const body = yield* objects.get(row.object_key);
        if (!body) {
          const next = yield* read(id, bucket, name);
          if (!retries || next.object_key === row.object_key)
            return yield* Effect.fail(new HttpApiError.ServiceUnavailable());
          return yield* deliver(actor, id, bucket, name, next, retries - 1);
        }
        const audit = yield* fileAuditInsert(
          sql,
          actor,
          sql`SELECT 'file_downloaded' AS outcome,${bucket} AS bucket,memory_id,name,size,sha256,NULL AS replaced_sha256 FROM memory_files WHERE memory_id=${id} AND name=${name} AND object_key=${row.object_key}`,
        ).pipe(unavailable, Effect.result);
        if (audit._tag === 'Failure') {
          yield* cancelled(body);
          return yield* Effect.fail(audit.failure);
        }
        if (audit.success.length) return { file: row, body };
        yield* cancelled(body);
        if (!retries)
          return yield* Effect.fail(new HttpApiError.ServiceUnavailable());
        const next = yield* read(id, bucket, name);
        return yield* deliver(actor, id, bucket, name, next, retries - 1);
      });
    const publishedFile = (
      id: string,
      bucket: string,
      file: FileRow,
      previous: FileState | undefined,
    ) =>
      Effect.gen(function* () {
        // A thrown/ambiguous batch never reaches cleanup. After a committed
        // upsert, the previous key is unreferenced and can never be reused.
        if (previous?.object_key) yield* remove([previous.object_key]);
        return attached(
          id,
          bucket,
          file,
          previous?.object_key ? 'replaced' : 'created',
          previous?.sha256 ?? null,
        );
      });
    return {
      remove,
      attach: (actor: FileActor, input: Upload) =>
        Effect.gen(function* () {
          const startedAt = fileNow(bindings);
          yield* validUpload(input);
          const bucket = yield* authorize(input.id, true);
          const hash = yield* Effect.promise(async () => {
            const digest = await crypto.subtle.digest(
              'SHA-256',
              input.bytes as Uint8Array<ArrayBuffer>,
            );
            return Array.from(new Uint8Array(digest), (b) =>
              b.toString(16).padStart(2, '0'),
            ).join('');
          });
          const pre = (yield* state(input.id, bucket, input.name).pipe(
            unavailable,
          ))[0];
          if (!pre?.id) return yield* Effect.fail(memoryNotFound());
          if (pre.sha256 === hash)
            return attached(
              input.id,
              bucket,
              pre as FileState & FileRow,
              'unchanged',
            );
          if (quotaExceeded(pre, input.bytes.byteLength))
            return yield* Effect.fail(
              quotaError(bucket, input.name, pre.usage, input.bytes.byteLength),
            );
          const key = `files/${crypto.randomUUID()}`;
          const file: FileRow = {
            name: input.name,
            media_type: input.mediaType,
            object_key: key,
            size: input.bytes.byteLength,
            sha256: hash,
          };
          yield* objects.put(key, input.bytes, hash);
          const machine =
            actor.principal.kind === 'machine' ? actor.principal : null;
          const usage = sql`(SELECT COALESCE(sum(u.size),0) FROM memory_files u JOIN memories h ON h.id=u.memory_id WHERE h.bucket=${bucket} AND NOT (u.memory_id=${input.id} AND u.name=${input.name}))`;
          // Both writes use all four guards against the same D1 snapshot. Only
          // D1's clock decides whether this never-reused key can still publish.
          const publishable = sql`m.id=${input.id} AND m.bucket=${bucket} AND COALESCE(f.sha256,'')<>${hash} AND ${usage}+${file.size}<=${fileLimits.bucketBytes} AND unixepoch('subsec')*1000-${startedAt}<${publishWindowMs}`;
          const from = sql`FROM memories m LEFT JOIN memory_files f ON f.memory_id=m.id AND f.name=${input.name} WHERE ${publishable}`;
          // The guarded audit INSERT is a batch-local receipt of all four
          // predicates. Decide once using D1's clock: a tick between statements
          // must not leave an audit entry without its file. No file state can
          // change between these two statements in the atomic batch.
          const publication = sql`FROM memories m WHERE m.id=${input.id} AND m.bucket=${bucket} AND changes()=1`;
          const [before, , published, after] = yield* sql
            .batch([
              state(input.id, bucket, input.name),
              fileAuditInsert(
                sql,
                actor,
                sql`SELECT CASE WHEN f.object_key IS NULL THEN 'file_attached' ELSE 'file_replaced' END AS outcome, m.bucket, m.id AS memory_id, ${input.name} AS name, ${file.size} AS size, ${hash} AS sha256, f.sha256 AS replaced_sha256 ${from}`,
              ),
              sql`INSERT INTO memory_files(memory_id,name,object_key,media_type,size,sha256,principal,machine_id,machine_name,client_name,client_version,attached_at) SELECT m.id,${input.name},${key},${input.mediaType},${file.size},${hash},${actor.principal.kind},${machine?.id ?? null},${machine?.name ?? null},${actor.client.name},${actor.client.version},${new Date().toISOString()} ${publication} ON CONFLICT(memory_id,name) DO UPDATE SET object_key=excluded.object_key,media_type=excluded.media_type,size=excluded.size,sha256=excluded.sha256,principal=excluded.principal,machine_id=excluded.machine_id,machine_name=excluded.machine_name,client_name=excluded.client_name,client_version=excluded.client_version,attached_at=excluded.attached_at RETURNING object_key`,
              state(input.id, bucket, input.name),
            ])
            .pipe(unavailable);
          if (published.length)
            return yield* publishedFile(input.id, bucket, file, before[0]);
          yield* remove([key]);
          return yield* notPublished(after[0], input, bucket, hash);
        }),
      detach: (actor: FileActor, input: DetachFile) =>
        Effect.gen(function* () {
          const bucket = yield* authorize(input.id, true);
          yield* validName(input.name);
          if (!isFileDigest(input.sha256))
            return yield* Effect.fail(
              new InvalidFile({
                message: 'Use a lowercase SHA-256 digest for the file.',
              }),
            );
          const guard = sql`memory_id=${input.id} AND name=${input.name} AND sha256=${input.sha256}`;
          const [, deleted, after] = yield* sql
            .batch([
              fileAuditInsert(
                sql,
                actor,
                sql`SELECT 'file_detached' AS outcome,${bucket} AS bucket,memory_id,name,size,sha256,NULL AS replaced_sha256 FROM memory_files WHERE ${guard}`,
              ),
              sql<{
                object_key: string;
              }>`DELETE FROM memory_files WHERE ${guard} RETURNING object_key`,
              state(input.id, bucket, input.name),
            ])
            .pipe(unavailable);
          if (deleted.length) {
            yield* remove(deleted.map((row) => row.object_key));
            return {
              id: input.id,
              bucket,
              name: input.name,
              sha256: input.sha256,
            } satisfies Detached;
          }
          const current = yield* requireFile(after[0]);
          return yield* Effect.fail(
            new FileChanged({
              message: `${input.name} changed: its sha256 is now ${current.sha256}, not ${input.sha256}. Get the memory again before detaching.`,
            }),
          );
        }),
      download: (actor: FileActor, id: string, name: string) =>
        Effect.gen(function* () {
          const bucket = yield* authorize(id);
          yield* validName(name);
          return yield* deliver(
            actor,
            id,
            bucket,
            name,
            yield* read(id, bucket, name),
            1,
          );
        }),
    };
  });
