import { D1Client } from '@effect/sql-d1';
import { Effect, Schema } from 'effect';
import { unavailable } from './http-errors.ts';
import { memoryBounds } from './memory-bounds.ts';
import {
  type EmbeddingMemory,
  type MemoryIndex,
  vectorBucket,
} from './memory-index.ts';

const EmbeddingRows = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    bucket: Schema.String,
    content_hash: Schema.String,
    content: Schema.String,
  }),
);

export const memorySync = (
  index: MemoryIndex,
  waitUntil?: (promise: Promise<unknown>) => void,
) =>
  Effect.gen(function* () {
    const sql = yield* D1Client.D1Client;
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
                sql`UPDATE memories SET embedding_marker=CASE WHEN content_hash=${row.content_hash} THEN ${index.marker(row.content_hash)} ELSE NULL END WHERE id=${row.id}`,
            ),
          )
          .pipe(unavailable);
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
        }>`SELECT r.id,r.forgotten_at FROM memory_vector_removals r WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id=r.id) ORDER BY r.forgotten_at,r.id LIMIT ${memoryBounds.indexChunk}`.pipe(
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
                Date.parse(row.forgotten_at) + memoryBounds.removalSettleMs,
          )
          .map((row) => row.id);
        if (settled.length)
          yield* sql`DELETE FROM memory_vector_removals WHERE ${sql.in('id', settled)} AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.id=memory_vector_removals.id)`.pipe(
            unavailable,
          );
      });
    const inspect = (scheduledTime: number, repaired: readonly string[]) =>
      Effect.gen(function* () {
        const cutoff = new Date(
          scheduledTime - memoryBounds.inspectionSettleMs,
        ).toISOString();
        // The window rotates over stable seq order, including pending markers,
        // so invalidation and repair cannot shrink the sweep under its cursor.
        const slots = yield* sql<{
          n: number;
        }>`SELECT count(*) AS n FROM memories WHERE updated_at < ${cutoff}`.pipe(
          unavailable,
        );
        const pages = Math.ceil((slots[0]?.n ?? 0) / memoryBounds.indexChunk);
        if (!pages) return;
        const offset =
          (Math.floor(scheduledTime / memoryBounds.rotationSlotMs) % pages) *
          memoryBounds.indexChunk;
        const rows = yield* sql<{
          id: string;
          bucket: string;
          content_hash: string;
        }>`SELECT id,bucket,content_hash FROM (SELECT * FROM memories WHERE updated_at < ${cutoff} ORDER BY seq LIMIT ${memoryBounds.indexChunk} OFFSET ${offset}) WHERE embedding_marker=${index.markerSql(sql, sql`content_hash`)} AND NOT ${sql.in('id', repaired)}`.pipe(
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
                vector.bucket !== (await vectorBucket(row.bucket))
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
                  sql`UPDATE memories SET embedding_marker=NULL WHERE id=${row.id} AND content_hash=${row.content_hash} AND updated_at < ${cutoff} AND embedding_marker=${index.markerSql(sql, sql`content_hash`)}`,
              ),
            )
            .pipe(unavailable);
      });
    return {
      scheduleEmbedding,
      sync: (scheduledTime = Date.now()) =>
        Effect.gen(function* () {
          yield* sweepRemovals(scheduledTime).pipe(
            Effect.catchCause(() => Effect.void),
          );
          const raw =
            yield* sql`SELECT m.id, m.bucket, m.content_hash, v.content FROM memories m JOIN memory_versions v ON v.memory_id=m.id AND v.version=m.current_version WHERE embedding_marker IS NULL OR embedding_marker <> ${index.markerSql(sql, sql`m.content_hash`)} ORDER BY m.seq LIMIT ${memoryBounds.indexChunk}`.pipe(
              unavailable,
            );
          const rows =
            yield* Schema.decodeUnknownEffect(EmbeddingRows)(raw).pipe(
              unavailable,
            );
          yield* embedding(rows).pipe(Effect.catchCause(() => Effect.void));
          yield* inspect(
            scheduledTime,
            rows.map((row) => row.id),
          ).pipe(Effect.catchCause(() => Effect.void));
        }),
    };
  });
