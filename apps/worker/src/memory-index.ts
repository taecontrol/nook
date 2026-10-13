import type {
  VectorizeIndex,
  VectorizeVector,
} from '@cloudflare/workers-types';
import { Effect, Schema } from 'effect';
import { sha256 } from './digest.ts';

export type SearchBindings = {
  AI?: {
    run(
      model: string,
      input: { text: string[]; truncate_inputs: boolean },
    ): Promise<unknown>;
  };
  MEMORY_INDEX?: Pick<VectorizeIndex, 'query' | 'upsert' | 'getByIds'>;
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
        }),
      ),
    ),
  }),
);
export type MeaningHit = { id: string; contentHash: string; rank: number };

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
    query: (query: string, paths: readonly string[]) =>
      Effect.gen(function* () {
        const [values] = yield* embed([query]);
        const bucket = yield* Effect.promise(() =>
          Promise.all(
            paths.map(async (path) => (await sha256(path)).slice(0, 32)),
          ),
        );
        const raw = yield* Effect.tryPromise(() => {
          if (!env.MEMORY_INDEX)
            throw new Error('Meaning search is unavailable.');
          return env.MEMORY_INDEX.query([...values], {
            topK: 50,
            returnMetadata: 'all',
            filter: { bucket: { $in: bucket } },
          });
        });
        const { matches } = yield* Schema.decodeUnknownEffect(Matches)(raw);
        return matches.slice(0, 50).map(
          (hit, i): MeaningHit => ({
            id: hit.id,
            contentHash: hit.metadata?.contentHash ?? '',
            rank: i + 1,
          }),
        );
      }),
    inspect: (ids: string[]) =>
      Effect.gen(function* () {
        const raw = yield* Effect.tryPromise(() => {
          if (!env.MEMORY_INDEX)
            throw new Error('Meaning search is unavailable.');
          return env.MEMORY_INDEX.getByIds(ids);
        });
        const vectors =
          yield* Schema.decodeUnknownEffect(InspectedVectors)(raw);
        return vectors.map((v) => ({
          id: v.id,
          bucket: v.metadata?.bucket,
          contentHash: v.metadata?.contentHash,
        }));
      }),
    write: (
      rows: readonly EmbeddingMemory[],
      current: (
        rows: readonly EmbeddingMemory[],
      ) => Effect.Effect<readonly EmbeddingMemory[], unknown> = (rows) =>
        Effect.succeed(rows),
    ) =>
      Effect.gen(function* () {
        const vectors: VectorizeVector[] = [];
        for (let offset = 0; offset < rows.length; offset += 32) {
          const batch = rows.slice(offset, offset + 32);
          const data = yield* embed(batch.map((row) => row.content));
          const entries = yield* Effect.promise(() =>
            Promise.all(
              batch.map(async (row, i) => ({
                id: row.id,
                values: [...data[i]],
                metadata: {
                  bucket: (await sha256(row.bucket)).slice(0, 32),
                  contentHash: row.content_hash,
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
