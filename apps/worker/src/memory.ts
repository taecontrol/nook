import { D1Client } from '@effect/sql-d1';
import {
  type BucketGrant,
  BucketNotFound,
  canRead,
  canWrite,
  InvalidBucketPath,
  InvalidMemory,
  InvalidMemoryCursor,
  type Memory,
  type MemoryClient,
  type MemoryListItem,
  MemoryNotFound,
  type MemoryScope,
  memoryTitle,
  type Principal,
  type Remember,
  readLineage,
  validateBucketPath,
  validateMemoryContent,
  validateTags,
  validateWorkingDirectory,
} from '@nook/contract';
import { Effect, Schema } from 'effect';
import { HttpApiError } from 'effect/http-api';
import { unavailable } from './http-errors.ts';

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const notFound = () => new MemoryNotFound({ message: 'Memory not found.' });
const bucketMissing = () =>
  new BucketNotFound({ message: 'Bucket not found.' });
const Facts = Schema.Struct({
  id: Schema.String,
  bucket: Schema.String,
  current_version: Schema.Number,
  content: Schema.String,
  tags: Schema.fromJsonString(Schema.Array(Schema.String)),
  created_at: Schema.String,
  updated_at: Schema.String,
  client_name: Schema.String,
  client_version: Schema.NullOr(Schema.String),
  working_directory: Schema.NullOr(Schema.String),
  version_at: Schema.String,
});
const Row = Schema.Union([
  Facts.mapFields((fields) => ({
    ...fields,
    principal: Schema.Literal('owner'),
    machine_id: Schema.Null,
    machine_name: Schema.Null,
  })),
  Facts.mapFields((fields) => ({
    ...fields,
    principal: Schema.Literal('machine'),
    machine_id: Schema.String,
    machine_name: Schema.String,
  })),
]);
type Row = typeof Row.Type;
function memory(row: Row): Memory {
  return {
    id: row.id,
    bucket: row.bucket,
    content: row.content,
    tags: row.tags,
    version: row.current_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    provenance: {
      client: { name: row.client_name, version: row.client_version },
      principal:
        row.principal === 'machine'
          ? { kind: 'machine', id: row.machine_id, name: row.machine_name }
          : { kind: 'owner' },
      workingDirectory: row.working_directory,
      at: row.version_at,
    },
  };
}
function summary(row: Row): MemoryListItem {
  const { content, ...facts } = memory(row);
  return { ...facts, title: memoryTitle(content) };
}
function validBucket(bucket: string) {
  const message = validateBucketPath(bucket);
  return message
    ? Effect.fail(new InvalidBucketPath({ message }))
    : Effect.void;
}
function validInput(input: Remember) {
  const message =
    validateMemoryContent(input.content) ??
    validateTags(input.tags ?? []) ??
    (input.workingDirectory === undefined
      ? undefined
      : validateWorkingDirectory(input.workingDirectory));
  return message ? Effect.fail(new InvalidMemory({ message })) : Effect.void;
}
type Cursor = { bucket: string; scope: MemoryScope; at: string; id: string };
// Versioned checksums detect altered opaque cursors; grants authorize each page.
async function encodeCursor({ bucket, scope, at, id }: Cursor) {
  const payload = { bucket, scope, at, id };
  const checksum = await sha256(JSON.stringify(payload));
  return btoa(JSON.stringify({ v: 1, ...payload, checksum }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
function cursorMatches(cursor: Cursor, bucket: string, scope: MemoryScope) {
  return (
    cursor.bucket === bucket &&
    cursor.scope === scope &&
    typeof cursor.id === 'string' &&
    uuid.test(cursor.id) &&
    typeof cursor.at === 'string' &&
    new Date(cursor.at).toISOString() === cursor.at
  );
}
function decodeCursor(bucket: string, scope: MemoryScope, cursor?: string) {
  return Effect.tryPromise({
    try: async () => {
      if (cursor === undefined) return undefined;
      if (!cursor || cursor.length > 1024) throw new InvalidMemoryCursor();
      const decoded = JSON.parse(
        atob(cursor.replaceAll('-', '+').replaceAll('_', '/')),
      ) as Cursor;
      if (
        !cursorMatches(decoded, bucket, scope) ||
        (await encodeCursor(decoded)) !== cursor
      )
        throw new InvalidMemoryCursor();
      return decoded;
    },
    catch: () => new InvalidMemoryCursor(),
  });
}
async function memoryPage(
  rows: readonly Row[],
  bucket: string,
  scope: MemoryScope,
) {
  const page = rows.slice(0, 25);
  const last = page.at(-1);
  return {
    memories: page.map(summary),
    next:
      rows.length > 25 && last
        ? await encodeCursor({
            bucket,
            scope,
            at: last.created_at,
            id: last.id,
          })
        : null,
  };
}
async function sha256(content: string) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(content),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
type State = {
  has_bucket: number;
  id: string | null;
  current_version: number;
  created_at: string;
  content: string;
  tags: string;
};
function rememberOutcome(
  state: State | undefined,
  input: Remember,
  created: boolean,
) {
  return Effect.gen(function* () {
    if (!state?.has_bucket) return yield* Effect.fail(bucketMissing());
    if (!state.id || state.content !== input.content)
      return yield* Effect.fail(new HttpApiError.ServiceUnavailable());
    const tags = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Array(Schema.String)),
    )(state.tags).pipe(unavailable);
    return {
      created,
      id: state.id,
      bucket: input.bucket,
      version: state.current_version,
      tags,
      createdAt: state.created_at,
    };
  });
}

export const memoryStore = (grant: BucketGrant) =>
  Effect.gen(function* () {
    const sql = yield* D1Client.D1Client;
    const columns = sql`m.id, m.bucket, m.current_version, m.created_at, m.updated_at, v.content, v.tags, v.client_name, v.client_version, v.principal, v.machine_id, v.machine_name, v.working_directory, v.created_at AS version_at`;
    return {
      remember: (principal: Principal, client: MemoryClient, input: Remember) =>
        Effect.gen(function* () {
          yield* validBucket(input.bucket);
          if (!canWrite(grant, input.bucket))
            return yield* Effect.fail(new HttpApiError.Forbidden());
          yield* validInput(input);
          const hash = yield* Effect.promise(() => sha256(input.content));
          const id = crypto.randomUUID();
          const now = new Date().toISOString();
          const machineId = principal.kind === 'machine' ? principal.id : null;
          const machineName =
            principal.kind === 'machine' ? principal.name : null;
          const [inserted, , state] = yield* sql
            .batch([
              sql`INSERT INTO memories(id, bucket, current_version, content_hash, created_at, updated_at) SELECT ${id}, ${input.bucket}, 1, ${hash}, ${now}, ${now} WHERE EXISTS (SELECT 1 FROM buckets WHERE path=${input.bucket}) ON CONFLICT(bucket, content_hash) DO NOTHING RETURNING id`,
              sql`INSERT INTO memory_versions(memory_id, version, content, tags, client_name, client_version, principal, machine_id, machine_name, working_directory, created_at) SELECT id, 1, ${input.content}, ${JSON.stringify(input.tags ?? [])}, ${client.name}, ${client.version}, ${principal.kind}, ${machineId}, ${machineName}, ${input.workingDirectory ?? null}, ${now} FROM memories WHERE id=${id}`,
              sql<State>`SELECT EXISTS (SELECT 1 FROM buckets WHERE path=${input.bucket}) AS has_bucket, m.id, m.current_version, m.created_at, v.content, v.tags FROM (SELECT 1) LEFT JOIN memories m ON m.bucket=${input.bucket} AND m.content_hash=${hash} LEFT JOIN memory_versions v ON v.memory_id=m.id AND v.version=m.current_version`,
            ])
            .pipe(unavailable);
          return yield* rememberOutcome(state[0], input, inserted.length > 0);
        }),
      get: (id: string) =>
        Effect.gen(function* () {
          if (!uuid.test(id)) return yield* Effect.fail(notFound());
          const rows =
            yield* sql`SELECT ${columns} FROM memories m JOIN memory_versions v ON v.memory_id=m.id AND v.version=m.current_version WHERE m.id=${id}`.pipe(
              unavailable,
            );
          if (!rows[0] || !canRead(grant, rows[0].bucket as string))
            return yield* Effect.fail(notFound());
          const row = yield* Schema.decodeUnknownEffect(Row)(rows[0]).pipe(
            unavailable,
          );
          return memory(row);
        }),
      list: (
        bucket: string,
        cursor?: string,
        scope: MemoryScope = 'inherited',
      ) =>
        Effect.gen(function* () {
          yield* validBucket(bucket);
          if (!canRead(grant, bucket))
            return yield* Effect.fail(new HttpApiError.Forbidden());
          const after = yield* decodeCursor(bucket, scope, cursor);
          const paths = (
            scope === 'bucket' ? [bucket] : readLineage(bucket)
          ).filter((path) => canRead(grant, path));
          const boundary = after
            ? sql`(m.created_at < ${after.at} OR (m.created_at=${after.at} AND m.id < ${after.id}))`
            : sql`1`;
          const validCursor = after
            ? sql`EXISTS (SELECT 1 FROM memories WHERE id=${after.id} AND created_at=${after.at} AND ${sql.in('bucket', paths)})`
            : sql`1`;
          const [exists, raw] = yield* sql
            .batch([
              sql<{
                has_bucket: number;
                has_cursor: number;
              }>`SELECT EXISTS (SELECT 1 FROM buckets WHERE path=${bucket}) AS has_bucket, ${validCursor} AS has_cursor`,
              sql`SELECT ${columns} FROM memories m JOIN memory_versions v ON v.memory_id=m.id AND v.version=m.current_version WHERE ${sql.in('m.bucket', paths)} AND ${boundary} ORDER BY m.created_at DESC, m.id DESC LIMIT 26`,
            ])
            .pipe(unavailable);
          if (!exists[0]?.has_bucket)
            return yield* Effect.fail(bucketMissing());
          if (!exists[0].has_cursor)
            return yield* Effect.fail(new InvalidMemoryCursor());
          const rows = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(
            raw,
          ).pipe(unavailable);
          return yield* Effect.tryPromise(() =>
            memoryPage(rows, bucket, scope),
          ).pipe(unavailable);
        }),
      counts: () =>
        Effect.gen(function* () {
          const rows =
            yield* sql`SELECT b.path AS bucket, count(m.id) AS count FROM buckets b LEFT JOIN memories m ON m.bucket=b.path GROUP BY b.path ORDER BY b.path`.pipe(
              unavailable,
            );
          const decoded = yield* Schema.decodeUnknownEffect(
            Schema.Array(
              Schema.Struct({ bucket: Schema.String, count: Schema.Number }),
            ),
          )(rows).pipe(unavailable);
          return {
            counts: decoded.filter((row) => canRead(grant, row.bucket)),
          };
        }),
    };
  });
