import type {
  VectorizeIndex,
  VectorizeVector,
} from '@cloudflare/workers-types';
import { Array as Arr, Effect, Schema } from 'effect';
import type { SqlClient, Statement } from 'effect/sql';
import { sha256 } from './digest.ts';
import { memoryBounds } from './memory-bounds.ts';

export type SearchBindings = {
  AI?: {
    run(
      model: string,
      input: { text: string[]; truncate_inputs: boolean },
    ): Promise<unknown>;
  };
  MEMORY_INDEX?: Pick<
    VectorizeIndex,
    'query' | 'upsert' | 'getByIds' | 'deleteByIds'
  >;
  EMBEDDING_MODEL?: string;
};
export type EmbeddingMemory = {
  id: string;
  bucket: string;
  content: string;
  content_hash: string;
};
const Embeddings = Schema.Struct({
  data: Schema.Array(Schema.Array(Schema.Number)),
});
const Matches = Schema.Struct({
  matches: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      metadata: Schema.optionalKey(
        Schema.NullOr(
          Schema.Struct({ contentHash: Schema.optionalKey(Schema.String) }),
        ),
      ),
    }),
  ),
});
const InspectedVectors = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    metadata: Schema.optionalKey(
      Schema.NullOr(
        Schema.Struct({
          bucket: Schema.optionalKey(Schema.String),
          contentHash: Schema.optionalKey(Schema.String),
          model: Schema.optionalKey(Schema.String),
        }),
      ),
    ),
  }),
);
export type MeaningHit = { id: string; contentHash: string; rank: number };

export async function vectorBucket(path: string) {
  return (await sha256(path)).slice(0, 32);
}

function inBatches<A>(
  ids: readonly string[],
  size: number,
  call: (batch: string[]) => Promise<A>,
) {
  return Effect.forEach(Arr.chunksOf(ids, size), (batch) =>
    Effect.tryPromise(() => call(batch)),
  );
}

export function memoryIndex(env: SearchBindings = {}) {
  const model = env.EMBEDDING_MODEL ?? '@cf/baai/bge-m3';
  const embed = (text: string[]) =>
    Effect.gen(function* () {
      const raw = yield* Effect.tryPromise(() => {
        if (!env.AI) throw new Error('Meaning search is unavailable.');
        return env.AI.run(model, { text, truncate_inputs: true });
      });
      const { data } = yield* Schema.decodeUnknownEffect(Embeddings)(raw);
      if (
        data.length !== text.length ||
        data.some(
          (vector) =>
            vector.length !== 1024 || vector.some((n) => !Number.isFinite(n)),
        )
      )
        return yield* Effect.fail(new Error('Invalid embedding response.'));
      return data;
    });
  return {
    model,
    marker: (hash: string) => `${model}:${hash}`,
    markerSql: (sql: SqlClient.SqlClient, hash: Statement.Fragment) =>
      sql`${model} || ':' || ${hash}`,
    remove: (ids: string[]) =>
      inBatches(ids, memoryBounds.vectorDeleteIds, (batch) => {
        if (!env.MEMORY_INDEX)
          throw new Error('Meaning search is unavailable.');
        return env.MEMORY_INDEX.deleteByIds(batch);
      }),
    query: (query: string, paths: readonly string[]) =>
      Effect.gen(function* () {
        const [values] = yield* embed([query]);
        const bucket = yield* Effect.promise(() =>
          Promise.all(paths.map(vectorBucket)),
        );
        const raw = yield* Effect.tryPromise(() => {
          if (!env.MEMORY_INDEX)
            throw new Error('Meaning search is unavailable.');
          return env.MEMORY_INDEX.query([...values], {
            topK: memoryBounds.meaningTopK,
            returnMetadata: 'all',
            filter: { bucket: { $in: bucket } },
          });
        });
        const { matches } = yield* Schema.decodeUnknownEffect(Matches)(raw);
        return matches.slice(0, memoryBounds.meaningTopK).map(
          (hit, i): MeaningHit => ({
            id: hit.id,
            contentHash: hit.metadata?.contentHash ?? '',
            rank: i + 1,
          }),
        );
      }),
    inspect: (ids: string[]) =>
      Effect.gen(function* () {
        const raw = yield* inBatches(
          ids,
          memoryBounds.vectorGetIds,
          (batch) => {
            if (!env.MEMORY_INDEX)
              throw new Error('Meaning search is unavailable.');
            return env.MEMORY_INDEX.getByIds(batch);
          },
        );
        const vectors = yield* Schema.decodeUnknownEffect(InspectedVectors)(
          raw.flat(),
        );
        return vectors.map((v) => ({
          id: v.id,
          bucket: v.metadata?.bucket,
          contentHash: v.metadata?.contentHash,
          model: v.metadata?.model,
        }));
      }),
    write: (
      rows: readonly EmbeddingMemory[],
      current: (
        rows: readonly EmbeddingMemory[],
      ) => Effect.Effect<readonly EmbeddingMemory[], unknown>,
    ) =>
      Effect.gen(function* () {
        const vectors: VectorizeVector[] = [];
        for (
          let offset = 0;
          offset < rows.length;
          offset += memoryBounds.embeddingChunk
        ) {
          const batch = rows.slice(
            offset,
            offset + memoryBounds.embeddingChunk,
          );
          const data = yield* embed(batch.map((row) => row.content));
          const entries = yield* Effect.promise(() =>
            Promise.all(
              batch.map(async (row, i) => ({
                id: row.id,
                values: [...data[i]],
                // Inspection compares the producing model: a marker cannot
                // tell a late write from another deployment's model apart.
                metadata: {
                  bucket: await vectorBucket(row.bucket),
                  contentHash: row.content_hash,
                  model,
                },
              })),
            ),
          );
          vectors.push(...entries);
        }
        const accepted = yield* current(rows);
        const ids = new Set(accepted.map((row) => row.id));
        const fresh = vectors.filter((v) => ids.has(v.id));
        if (!fresh.length) return accepted;
        yield* Effect.tryPromise(() => {
          if (!env.MEMORY_INDEX)
            throw new Error('Meaning search is unavailable.');
          return env.MEMORY_INDEX.upsert(fresh);
        });
        return accepted;
      }),
  };
}
export type MemoryIndex = ReturnType<typeof memoryIndex>;
