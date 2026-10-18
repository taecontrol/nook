import { D1Client } from '@effect/sql-d1';
import {
  type BucketGrant,
  canRead,
  canWrite,
  DuplicateMemory,
  type ForgetMemory,
  type Forgotten,
  InvalidMemory,
  InvalidMemoryCursor,
  InvalidMemorySearch,
  type Memory,
  MemoryChanged,
  type MemoryClient,
  type MemoryListItem,
  MemoryNotFound,
  type MemoryScope,
  type MemoryVersion,
  memoryTitle,
  type OwnerMemorySearchResult,
  type Principal,
  type Remember,
  type UpdateMemory,
  validateExpectedVersion,
  validateMemoryContent,
  validateSearchQuery,
  validateTags,
  validateWorkingDirectory,
  visiblePaths,
} from '@nook/contract';
import { Effect, Schema } from 'effect';
import { HttpApiError } from 'effect/http-api';
import { authorizeBucket, bucketExists, bucketNotFound } from './buckets.ts';
import { sha256 } from './digest.ts';
import { unavailable } from './http-errors.ts';
import {
  type EmbeddingMemory,
  type MemoryIndex,
  memoryIndex,
} from './memory-index.ts';
import {
  keywordExpression,
  keywordSnippet,
  openingSnippet,
  rankedSearch,
} from './memory-search.ts';

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const notFound = () => new MemoryNotFound({ message: 'Memory not found.' });
const vectorRemovalChunk = 50;
const vectorRemovalSettleMs = 30 * 60_000;
function forgetVersion(version: unknown, query: boolean) {
  if (query && typeof version === 'string' && /^[1-9]\d*$/.test(version))
    version = Number(version);
  const message = validateExpectedVersion(version);
  return message
    ? Effect.fail(new InvalidMemory({ message }))
    : Effect.succeed(version as number);
}
function forgetOutcome(
  deleted: boolean,
  current: number | null | undefined,
  input: ForgetMemory,
  bucket: string,
) {
  if (deleted)
    return Effect.succeed({
      id: input.id,
      bucket,
      version: input.expectedVersion,
    } satisfies Forgotten);
  if (current === undefined)
    return Effect.fail(new HttpApiError.ServiceUnavailable());
  if (current === null) return Effect.fail(notFound());
  if (current !== input.expectedVersion)
    return Effect.fail(
      new MemoryChanged({
        message: `This memory changed: it is now version ${current}, not ${input.expectedVersion}. Get it again before forgetting.`,
      }),
    );
  return Effect.fail(new HttpApiError.ServiceUnavailable());
}
const TagsJson = Schema.fromJsonString(Schema.Array(Schema.String));
function withProvenance<Fields extends Schema.Struct.Fields>(fields: Fields) {
  const facts = {
    ...fields,
    client_name: Schema.String,
    client_version: Schema.NullOr(Schema.String),
    working_directory: Schema.NullOr(Schema.String),
    version_at: Schema.String,
  };
  return Schema.Union([
    Schema.Struct({
      ...facts,
      principal: Schema.Literal('owner'),
      machine_id: Schema.Null,
      machine_name: Schema.Null,
    }),
    Schema.Struct({
      ...facts,
      principal: Schema.Literal('machine'),
      machine_id: Schema.String,
      machine_name: Schema.String,
    }),
  ]);
}
const facts = {
  id: Schema.String,
  bucket: Schema.String,
  current_version: Schema.Number,
  content: Schema.String,
  content_hash: Schema.String,
  keyword_snippet: Schema.optionalKey(Schema.String),
  tags: TagsJson,
  created_at: Schema.String,
  updated_at: Schema.String,
};
const Row = withProvenance(facts);
type Row = typeof Row.Type;
const MeaningRow = withProvenance({ ...facts, meaning_rank: Schema.Number });
const VersionRow = withProvenance({
  version: Schema.Number,
  content: Schema.String,
  tags: TagsJson,
});
type VersionRow = typeof VersionRow.Type;
const BucketRow = Schema.Struct({ bucket: Schema.String });
const ForgetState = Schema.Struct({
  current_version: Schema.NullOr(Schema.Number),
});
function decodedRows<S extends Schema.Top>(schema: S, raw: unknown) {
  return Schema.decodeUnknownEffect(Schema.Array(schema))(raw).pipe(
    unavailable,
  );
}
function provenanceOf(row: Row | VersionRow): Memory['provenance'] {
  return {
    client: { name: row.client_name, version: row.client_version },
    principal:
      row.principal === 'machine'
        ? { kind: 'machine', id: row.machine_id, name: row.machine_name }
        : { kind: 'owner' },
    workingDirectory: row.working_directory,
    at: row.version_at,
  };
}
function memory(row: Row): Memory {
  return {
    id: row.id,
    bucket: row.bucket,
    content: row.content,
    tags: row.tags,
    version: row.current_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    provenance: provenanceOf(row),
  };
}
function summary(row: Row): MemoryListItem {
  const { content, ...facts } = memory(row);
  return { ...facts, title: memoryTitle(content) };
}
function validInput(
  input: Pick<Remember, 'content' | 'tags' | 'workingDirectory'>,
) {
  const message =
    validateMemoryContent(input.content) ??
    validateTags(input.tags ?? []) ??
    (input.workingDirectory === undefined
      ? undefined
      : validateWorkingDirectory(input.workingDirectory));
  return message ? Effect.fail(new InvalidMemory({ message })) : Effect.void;
}
function validUpdate(input: UpdateMemory) {
  const message = validateExpectedVersion(input.expectedVersion);
  return message
    ? Effect.fail(new InvalidMemory({ message }))
    : validInput(input);
}
function machineFacts(principal: Principal) {
  return principal.kind === 'machine'
    ? { id: principal.id, name: principal.name }
    : { id: null, name: null };
}
function historyBoundary(before?: string) {
  if (before === undefined) return Effect.succeed(undefined);
  if (!/^[1-9]\d*$/.test(before) || !Number.isSafeInteger(Number(before)))
    return Effect.fail(new InvalidMemoryCursor());
  return Effect.succeed(Number(before));
}
function historyPage(rows: readonly VersionRow[]) {
  const page = rows.slice(0, 26);
  return {
    versions: page.map(
      (row): MemoryVersion => ({
        version: row.version,
        content: row.content,
        tags: row.tags,
        provenance: provenanceOf(row),
      }),
    ),
    next: rows.length > 26 ? (page.at(-1)?.version ?? null) : null,
  };
}
const UpdateState = Schema.Union([
  Schema.Struct({
    id: Schema.String,
    bucket: Schema.String,
    current_version: Schema.Number,
    created_at: Schema.String,
    updated_at: Schema.String,
    tags: Schema.String,
    equals_request: Schema.Number,
    stale: Schema.Number,
    duplicate_id: Schema.NullOr(Schema.String),
    hash_collision: Schema.Number,
    content_changed: Schema.Number,
  }),
  Schema.Struct({ id: Schema.Null }),
]);
type UpdateState = typeof UpdateState.Type;
function updateOutcome(
  state: UpdateState | undefined,
  input: UpdateMemory,
  updated: boolean,
) {
  return Effect.gen(function* () {
    if (!state?.id) return yield* Effect.fail(notFound());
    if (!updated && !state.equals_request) {
      if (state.stale)
        return yield* Effect.fail(
          new MemoryChanged({
            message: `This memory changed: it is now version ${state.current_version}, not ${input.expectedVersion}. Get it again before updating.`,
          }),
        );
      if (state.duplicate_id)
        return yield* Effect.fail(
          new DuplicateMemory({
            message: `Memory ${state.duplicate_id} in this bucket already has this content.`,
          }),
        );
      return yield* Effect.fail(new HttpApiError.ServiceUnavailable());
    }
    if (state.hash_collision)
      return yield* Effect.fail(new HttpApiError.ServiceUnavailable());
    const tags = yield* Schema.decodeUnknownEffect(TagsJson)(state.tags).pipe(
      unavailable,
    );
    return {
      updated,
      id: state.id,
      bucket: state.bucket,
      version: state.current_version,
      tags,
      createdAt: state.created_at,
      updatedAt: state.updated_at,
    };
  });
}
function validSearch(query: string, tags: readonly string[]) {
  const message = validateSearchQuery(query) ?? validateTags(tags);
  return message
    ? Effect.fail(new InvalidMemorySearch({ message }))
    : Effect.void;
}
function searchResult(
  row: Row,
  match: 'keyword' | 'meaning',
  delimiter: string,
): OwnerMemorySearchResult {
  return {
    id: row.id,
    bucket: row.bucket,
    title: memoryTitle(row.content),
    tags: row.tags,
    createdAt: row.created_at,
    provenance: provenanceOf(row),
    match,
    ...(row.keyword_snippet === undefined
      ? openingSnippet(row.content)
      : keywordSnippet(row.keyword_snippet, delimiter)),
  };
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
const State = Schema.Union([
  Schema.Struct({
    has_bucket: Schema.Number,
    id: Schema.String,
    current_version: Schema.Number,
    created_at: Schema.String,
    content: Schema.String,
    tags: Schema.String,
  }),
  Schema.Struct({ has_bucket: Schema.Number, id: Schema.Null }),
]);
type State = typeof State.Type;
function rememberOutcome(
  state: State | undefined,
  input: Remember,
  created: boolean,
) {
  return Effect.gen(function* () {
    if (!state?.has_bucket) return yield* Effect.fail(bucketNotFound());
    if (!state.id || state.content !== input.content)
      return yield* Effect.fail(new HttpApiError.ServiceUnavailable());
    const tags = yield* Schema.decodeUnknownEffect(TagsJson)(state.tags).pipe(
      unavailable,
    );
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

export const memoryStore = (
  grant: BucketGrant,
  index: MemoryIndex = memoryIndex(),
  waitUntil?: (promise: Promise<unknown>) => void,
) =>
  Effect.gen(function* () {
    const sql = yield* D1Client.D1Client;
    const provenanceSelect = sql`v.client_name, v.client_version, v.principal, v.machine_id, v.machine_name, v.working_directory, v.created_at AS version_at`;
    const columns = sql`m.id, m.bucket, m.current_version, m.content_hash, m.created_at, m.updated_at, v.content, v.tags, ${provenanceSelect}`;
    const provenanceColumns = sql`client_name,client_version,principal,machine_id,machine_name,working_directory,created_at`;
    const provenanceValues = (
      principal: Principal,
      client: MemoryClient,
      directory: string | undefined,
      at: string,
    ) => {
      const author = machineFacts(principal);
      return sql`${client.name},${client.version},${principal.kind},${author.id},${author.name},${directory ?? null},${at}`;
    };
    const embedding = (rows: readonly EmbeddingMemory[]) =>
      Effect.gen(function* () {
        if (!rows.length) return;
        // Filter after the slow AI request, immediately before the external upsert.
        const written = yield* index
          .write(rows, (candidates) =>
            Effect.gen(function* () {
              const current = yield* sql<{
                id: string;
                content_hash: string;
              }>`SELECT id, content_hash FROM memories WHERE ${sql.in(
                'id',
                candidates.map((row) => row.id),
              )}`.pipe(unavailable);
              return candidates.filter((row) =>
                current.some(
                  (m) => m.id === row.id && m.content_hash === row.content_hash,
                ),
              );
            }),
          )
          .pipe(unavailable);
        if (!written.length) return;
        yield* sql
          .batch(
            written.map(
              (row) =>
                sql`UPDATE memories SET embedding_marker=CASE WHEN content_hash=${row.content_hash} THEN ${`${index.model}:${row.content_hash}`} ELSE NULL END WHERE id=${row.id}`,
            ),
          )
          .pipe(unavailable);
      });
    const bucketFor = (id: string, write = false) =>
      Effect.gen(function* () {
        if (!uuid.test(id)) return yield* Effect.fail(notFound());
        const heads = yield* sql<{
          bucket: string;
        }>`SELECT bucket FROM memories WHERE id=${id}`.pipe(unavailable);
        const bucket = heads[0]?.bucket;
        if (!bucket || !canRead(grant, bucket))
          return yield* Effect.fail(notFound());
        if (write && !canWrite(grant, bucket))
          return yield* Effect.fail(new HttpApiError.Forbidden());
        return bucket;
      });
    const scheduleEmbedding = (rows: readonly EmbeddingMemory[]) => {
      if (waitUntil)
        waitUntil(
          Effect.runPromise(
            embedding(rows).pipe(Effect.catchCause(() => Effect.void)),
          ),
        );
    };
    const sweepRemovals = (scheduledTime: number) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          id: string;
          forgotten_at: string;
        }>`SELECT r.id,r.forgotten_at FROM memory_vector_removals r WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id=r.id) ORDER BY r.forgotten_at,r.id LIMIT ${vectorRemovalChunk}`.pipe(
          unavailable,
        );
        if (!rows.length) return;
        const vectors = yield* index
          .inspect(rows.map((row) => row.id))
          .pipe(unavailable);
        const present = new Set(vectors.map((vector) => vector.id));
        const remove = rows
          .filter((row) => present.has(row.id))
          .map((row) => row.id);
        if (remove.length) yield* index.remove(remove).pipe(unavailable);
        const settled = rows
          .filter(
            (row) =>
              !present.has(row.id) &&
              scheduledTime >=
                Date.parse(row.forgotten_at) + vectorRemovalSettleMs,
          )
          .map((row) => row.id);
        if (settled.length)
          yield* sql`DELETE FROM memory_vector_removals WHERE ${sql.in('id', settled)} AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.id=memory_vector_removals.id)`.pipe(
            unavailable,
          );
      });
    const inspect = (scheduledTime: number, repaired: readonly string[]) =>
      Effect.gen(function* () {
        const cutoff = new Date(scheduledTime - 10 * 60_000).toISOString();
        // The window rotates over stable seq order, including pending markers,
        // so invalidation and repair cannot shrink the sweep under its cursor.
        const slots = yield* sql<{
          n: number;
        }>`SELECT count(*) AS n FROM memories WHERE updated_at < ${cutoff}`.pipe(
          unavailable,
        );
        const pages = Math.ceil((slots[0]?.n ?? 0) / 50);
        if (!pages) return;
        const offset = (Math.floor(scheduledTime / (5 * 60_000)) % pages) * 50;
        const rows = yield* sql<{
          id: string;
          bucket: string;
          content_hash: string;
        }>`SELECT id,bucket,content_hash FROM (SELECT * FROM memories WHERE updated_at < ${cutoff} ORDER BY seq LIMIT 50 OFFSET ${offset}) WHERE embedding_marker=${index.model} || ':' || content_hash AND NOT ${sql.in('id', repaired)}`.pipe(
          unavailable,
        );
        if (!rows.length) return;
        const vectors = yield* index
          .inspect(rows.map((row) => row.id))
          .pipe(unavailable);
        const wrong = yield* Effect.promise(async () => {
          const stale = await Promise.all(
            rows.map(async (row) => {
              const vector = vectors.find((v) => v.id === row.id);
              return !vector ||
                vector.contentHash !== row.content_hash ||
                vector.bucket !== (await sha256(row.bucket)).slice(0, 32)
                ? row
                : undefined;
            }),
          );
          return stale.filter((row) => row !== undefined);
        });
        if (wrong.length)
          yield* sql
            .batch(
              wrong.map(
                (row) =>
                  sql`UPDATE memories SET embedding_marker=NULL WHERE id=${row.id} AND content_hash=${row.content_hash} AND updated_at < ${cutoff} AND embedding_marker=${index.model} || ':' || content_hash`,
              ),
            )
            .pipe(unavailable);
      });
    return {
      forget: (
        input: { id: string; expectedVersion?: unknown },
        query = false,
      ) =>
        Effect.gen(function* () {
          const bucket = yield* bucketFor(input.id, true);
          const version = yield* forgetVersion(input.expectedVersion, query);
          const guard = sql`id=${input.id} AND bucket=${bucket} AND current_version=${version}`;
          const [, deleted, , states] = yield* sql
            .batch([
              sql`INSERT INTO memory_vector_removals(id,forgotten_at) SELECT id,${new Date().toISOString()} FROM memories WHERE ${guard}`,
              sql`DELETE FROM memories WHERE ${guard} AND EXISTS (SELECT 1 FROM memory_vector_removals r WHERE r.id=memories.id) RETURNING seq`,
              sql`INSERT INTO memories_fts(memories_fts) VALUES('optimize')`,
              sql`SELECT m.current_version FROM (SELECT 1) LEFT JOIN memories m ON m.id=${input.id} AND m.bucket=${bucket}`,
            ])
            .pipe(unavailable);
          const current = yield* decodedRows(ForgetState, states);
          return yield* forgetOutcome(
            deleted.length > 0,
            current[0]?.current_version,
            { id: input.id, expectedVersion: version },
            bucket,
          );
        }),
      update: (
        principal: Principal,
        client: MemoryClient,
        input: UpdateMemory,
      ) =>
        Effect.gen(function* () {
          const bucket = yield* bucketFor(input.id, true);
          yield* validUpdate(input);
          const hash = yield* Effect.promise(() => sha256(input.content));
          const tags =
            input.tags === undefined ? null : JSON.stringify(input.tags);
          const now = new Date().toISOString();
          const provenance = provenanceValues(
            principal,
            client,
            input.workingDirectory,
            now,
          );
          // Each write guard also supplies the outcome read; only precedence is TypeScript.
          const equal = sql`cur.content=${input.content} AND json(cur.tags)=json(COALESCE(${tags},cur.tags))`;
          const stale = sql`m.current_version <> ${input.expectedVersion}`;
          const other = sql`o.bucket=m.bucket AND o.id<>m.id AND o.content_hash=${hash}`;
          const duplicate = sql`EXISTS (SELECT 1 FROM memories o WHERE ${other})`;
          const collision = sql`m.content_hash=${hash} AND cur.content<>${input.content}`;
          const [inserted, , states] = yield* sql
            .batch([
              sql`INSERT INTO memory_versions(memory_id,version,content,tags,${provenanceColumns}) SELECT m.id,m.current_version+1,${input.content},COALESCE(${tags},cur.tags),${provenance} FROM memories m JOIN memory_versions cur ON cur.memory_id=m.id AND cur.version=m.current_version WHERE m.id=${input.id} AND m.bucket=${bucket} AND NOT (${stale}) AND NOT (${equal}) AND NOT (${duplicate}) AND NOT (${collision}) RETURNING version`,
              sql`UPDATE memories SET current_version=current_version+1,content_hash=${hash},updated_at=${now} WHERE id=${input.id} AND bucket=${bucket} AND current_version=${input.expectedVersion} AND EXISTS (SELECT 1 FROM memory_versions v WHERE v.memory_id=memories.id AND v.version=memories.current_version+1)`,
              sql`SELECT m.id,m.bucket,m.current_version,m.created_at,m.updated_at,cur.tags,(${equal}) AS equals_request,(${stale}) AS stale, (SELECT o.id FROM memories o JOIN memory_versions ov ON ov.memory_id=o.id AND ov.version=o.current_version WHERE ${other} AND ov.content=${input.content}) AS duplicate_id, ((${collision}) OR (${duplicate} AND NOT EXISTS (SELECT 1 FROM memories o JOIN memory_versions ov ON ov.memory_id=o.id AND ov.version=o.current_version WHERE ${other} AND ov.content=${input.content}))) AS hash_collision, EXISTS (SELECT 1 FROM memory_versions previous WHERE previous.memory_id=m.id AND previous.version=m.current_version-1 AND previous.content<>cur.content) AS content_changed FROM (SELECT 1) LEFT JOIN memories m ON m.id=${input.id} AND m.bucket=${bucket} LEFT JOIN memory_versions cur ON cur.memory_id=m.id AND cur.version=m.current_version`,
            ])
            .pipe(unavailable);
          const decoded = yield* decodedRows(UpdateState, states);
          const state = decoded[0];
          const result = yield* updateOutcome(
            state,
            input,
            inserted.length > 0,
          );
          if (result.updated && state?.id && state.content_changed)
            scheduleEmbedding([
              {
                id: input.id,
                bucket,
                content: input.content,
                content_hash: hash,
              },
            ]);
          return result;
        }),
      remember: (principal: Principal, client: MemoryClient, input: Remember) =>
        Effect.gen(function* () {
          yield* authorizeBucket(grant, input.bucket, 'write');
          yield* validInput(input);
          const hash = yield* Effect.promise(() => sha256(input.content));
          const id = crypto.randomUUID();
          const now = new Date().toISOString();
          const provenance = provenanceValues(
            principal,
            client,
            input.workingDirectory,
            now,
          );
          const [inserted, , state] = yield* sql
            .batch([
              sql`INSERT INTO memories(id, bucket, current_version, content_hash, created_at, updated_at) SELECT ${id}, ${input.bucket}, 1, ${hash}, ${now}, ${now} WHERE ${bucketExists(sql, input.bucket)} ON CONFLICT(bucket, content_hash) DO NOTHING RETURNING id`,
              sql`INSERT INTO memory_versions(memory_id, version, content, tags, ${provenanceColumns}) SELECT id, 1, ${input.content}, ${JSON.stringify(input.tags ?? [])}, ${provenance} FROM memories WHERE id=${id}`,
              sql`SELECT ${bucketExists(sql, input.bucket)} AS has_bucket, m.id, m.current_version, m.created_at, v.content, v.tags FROM (SELECT 1) LEFT JOIN memories m ON m.bucket=${input.bucket} AND m.content_hash=${hash} LEFT JOIN memory_versions v ON v.memory_id=m.id AND v.version=m.current_version`,
            ])
            .pipe(unavailable);
          const decoded = yield* decodedRows(State, state);
          const result = yield* rememberOutcome(
            decoded[0],
            input,
            inserted.length > 0,
          );
          if (result.created && waitUntil)
            waitUntil(
              Effect.runPromise(
                embedding([
                  {
                    id,
                    bucket: input.bucket,
                    content: input.content,
                    content_hash: hash,
                  },
                ]).pipe(Effect.catchCause(() => Effect.void)),
              ),
            );
          return result;
        }),
      sync: (scheduledTime = Date.now()) =>
        Effect.gen(function* () {
          yield* sweepRemovals(scheduledTime).pipe(
            Effect.catchCause(() => Effect.void),
          );
          const raw =
            yield* sql`SELECT m.id, m.bucket, m.content_hash, v.content FROM memories m JOIN memory_versions v ON v.memory_id=m.id AND v.version=m.current_version WHERE embedding_marker IS NULL OR embedding_marker <> ${index.model} || ':' || m.content_hash ORDER BY m.seq LIMIT 50`.pipe(
              unavailable,
            );
          const rows = yield* decodedRows(
            Schema.Struct({
              id: Schema.String,
              bucket: Schema.String,
              content_hash: Schema.String,
              content: Schema.String,
            }),
            raw,
          );
          yield* embedding(rows);
          yield* inspect(
            scheduledTime,
            rows.map((row) => row.id),
          ).pipe(Effect.catchCause(() => Effect.void));
        }),
      search: (
        bucket: string,
        query: string,
        tags: readonly string[] = [],
        scope: MemoryScope = 'inherited',
        limit = 20,
      ) =>
        Effect.gen(function* () {
          yield* authorizeBucket(grant, bucket, 'read');
          yield* validSearch(query, tags);
          const paths = visiblePaths(grant, bucket, scope);
          const expression = keywordExpression(query);
          const delimiter = `\u0001${crypto.randomUUID()}\u0002`;
          const tagged = sql`NOT EXISTS (SELECT 1 FROM json_each(${JSON.stringify(tags)}) wanted WHERE NOT EXISTS (SELECT 1 FROM json_each(v.tags) actual WHERE actual.value=wanted.value))`;
          const keywordQuery = expression
            ? sql`SELECT ${columns}, snippet(memories_fts, 0, ${delimiter}, ${delimiter}, '…', 40) AS keyword_snippet FROM memories_fts JOIN memories m ON m.seq=memories_fts.rowid JOIN memory_versions v ON v.memory_id=m.id AND v.version=m.current_version WHERE memories_fts MATCH ${expression} AND ${sql.in('m.bucket', paths)} AND ${tagged} ORDER BY bm25(memories_fts), m.created_at DESC, m.id DESC LIMIT 50`
            : sql`SELECT ${columns} FROM memories m JOIN memory_versions v ON v.memory_id=m.id AND v.version=m.current_version WHERE 0`;
          const [exists, rawKeyword] = yield* sql
            .batch([
              sql<{
                has_bucket: number;
              }>`SELECT ${bucketExists(sql, bucket)} AS has_bucket`,
              keywordQuery,
            ])
            .pipe(unavailable);
          if (!exists[0]?.has_bucket)
            return yield* Effect.fail(bucketNotFound());
          const keyword = yield* decodedRows(Row, rawKeyword);
          const meaning = yield* index.query(query, paths).pipe(
            Effect.map((hits) => ({
              hits,
              availability: 'available' as const,
            })),
            Effect.catchCause(() =>
              Effect.succeed({
                hits: [],
                availability: 'unavailable' as const,
              }),
            ),
          );
          const hits = JSON.stringify(meaning.hits);
          const keywordHeads = JSON.stringify(
            keyword.map((row) => ({
              id: row.id,
              version: row.current_version,
              hash: row.content_hash,
            })),
          );
          // Vectorize filtering is an optimization. Only current, scoped D1 rows reach the caller.
          const [rawMeaning, currentKeyword] = yield* sql
            .batch([
              sql`SELECT ${columns}, json_extract(hit.value, '$.rank') AS meaning_rank FROM json_each(${hits}) hit JOIN memories m ON m.id=json_extract(hit.value, '$.id') JOIN memory_versions v ON v.memory_id=m.id AND v.version=m.current_version WHERE m.content_hash=json_extract(hit.value, '$.contentHash') AND ${sql.in('m.bucket', paths)} AND ${tagged}`,
              sql<{
                id: string;
              }>`SELECT m.id FROM json_each(${keywordHeads}) hit JOIN memories m ON m.id=json_extract(hit.value,'$.id') WHERE m.current_version=json_extract(hit.value,'$.version') AND m.content_hash=json_extract(hit.value,'$.hash') AND ${sql.in('m.bucket', paths)}`,
              sql`UPDATE memories SET embedding_marker=NULL WHERE ${sql.in('bucket', paths)} AND EXISTS (SELECT 1 FROM json_each(${hits}) hit WHERE json_extract(hit.value, '$.id')=memories.id AND json_extract(hit.value, '$.contentHash') <> memories.content_hash)`,
            ])
            .pipe(unavailable);
          const semantic = yield* decodedRows(MeaningRow, rawMeaning);
          const currentIds = new Set(currentKeyword.map((row) => row.id));
          return {
            results: rankedSearch(
              keyword
                .filter((row) => currentIds.has(row.id))
                .map((row) => searchResult(row, 'keyword', delimiter)),
              semantic.map((row) => ({
                result: searchResult(row, 'meaning', delimiter),
                rank: row.meaning_rank,
              })),
              limit,
            ),
            meaning: meaning.availability,
          };
        }),
      get: (id: string) =>
        Effect.gen(function* () {
          if (!uuid.test(id)) return yield* Effect.fail(notFound());
          const rows =
            yield* sql`SELECT ${columns} FROM memories m JOIN memory_versions v ON v.memory_id=m.id AND v.version=m.current_version WHERE m.id=${id}`.pipe(
              unavailable,
            );
          if (!rows[0]) return yield* Effect.fail(notFound());
          const head = yield* Schema.decodeUnknownEffect(BucketRow)(
            rows[0],
          ).pipe(unavailable);
          if (!canRead(grant, head.bucket))
            return yield* Effect.fail(notFound());
          const row = yield* Schema.decodeUnknownEffect(Row)(rows[0]).pipe(
            unavailable,
          );
          return memory(row);
        }),
      history: (id: string, before?: string) =>
        Effect.gen(function* () {
          yield* bucketFor(id);
          const beforeVersion = yield* historyBoundary(before);
          const boundary =
            beforeVersion === undefined
              ? sql`1`
              : sql`v.version < ${beforeVersion}`;
          const raw =
            yield* sql`SELECT v.version,v.content,v.tags,${provenanceSelect} FROM memory_versions v JOIN memories m ON m.id=v.memory_id WHERE m.id=${id} AND ${boundary} ORDER BY v.version DESC LIMIT 27`.pipe(
              unavailable,
            );
          const rows = yield* decodedRows(VersionRow, raw);
          return historyPage(rows);
        }),
      list: (
        bucket: string,
        cursor?: string,
        scope: MemoryScope = 'inherited',
      ) =>
        Effect.gen(function* () {
          yield* authorizeBucket(grant, bucket, 'read');
          const after = yield* decodeCursor(bucket, scope, cursor);
          const paths = visiblePaths(grant, bucket, scope);
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
              }>`SELECT ${bucketExists(sql, bucket)} AS has_bucket, ${validCursor} AS has_cursor`,
              sql`SELECT ${columns} FROM memories m JOIN memory_versions v ON v.memory_id=m.id AND v.version=m.current_version WHERE ${sql.in('m.bucket', paths)} AND ${boundary} ORDER BY m.created_at DESC, m.id DESC LIMIT 26`,
            ])
            .pipe(unavailable);
          if (!exists[0]?.has_bucket)
            return yield* Effect.fail(bucketNotFound());
          if (!exists[0].has_cursor)
            return yield* Effect.fail(new InvalidMemoryCursor());
          const rows = yield* decodedRows(Row, raw);
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
          const decoded = yield* decodedRows(
            Schema.Struct({ bucket: Schema.String, count: Schema.Number }),
            rows,
          );
          return {
            counts: decoded.filter((row) => canRead(grant, row.bucket)),
          };
        }),
    };
  });
