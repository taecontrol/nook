import { D1Client } from '@effect/sql-d1';
import {
  BucketHasChildren,
  BucketNotFound,
  bucketLineage,
  InvalidBucketPath,
  ReservedBucket,
  validateBucketPath,
} from '@nook/contract';
import { Effect, Schema } from 'effect';
import { HttpApiError } from 'effect/http-api';
import { SqlSchema } from 'effect/sql';
import { type BucketGrant, canRead, canWrite } from './authorization.ts';

const Row = Schema.Struct({ path: Schema.String, created_at: Schema.String });
const unavailable = Effect.mapError(
  () => new HttpApiError.ServiceUnavailable(),
);
function writable(grant: BucketGrant, path: string) {
  const message = validateBucketPath(path);
  if (message) return Effect.fail(new InvalidBucketPath({ message }));
  if (!canWrite(grant, path)) return Effect.fail(new HttpApiError.Forbidden());
  return Effect.void;
}
export const bucketOperations = Effect.gen(function* () {
  const sql = yield* D1Client.D1Client;
  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Row,
    execute: () => sql`SELECT path, created_at FROM buckets ORDER BY path`,
  });
  return {
    list: (grant: BucketGrant) =>
      listRows().pipe(
        unavailable,
        Effect.map((rows) => ({
          buckets: rows
            .filter((row) => canRead(grant, row.path))
            .map((row) => ({ path: row.path, createdAt: row.created_at })),
        })),
      ),
    create: (grant: BucketGrant, path: string) =>
      Effect.gen(function* () {
        yield* writable(grant, path);
        const now = new Date().toISOString();
        const paths = bucketLineage(path);
        const results = yield* sql
          .batch(
            paths.map(
              (prefix) =>
                sql<{
                  path: string;
                }>`INSERT OR IGNORE INTO buckets(path, created_at) VALUES (${prefix}, ${now}) RETURNING path`,
            ),
          )
          .pipe(unavailable);
        return {
          path,
          created: (results.at(-1)?.length ?? 0) > 0,
          createdAncestors: results
            .slice(0, -1)
            .flatMap((rows) => rows.map((row) => row.path)),
        };
      }),
    delete: (grant: BucketGrant, path: string) =>
      Effect.gen(function* () {
        yield* writable(grant, path);
        if (path === 'me')
          return yield* Effect.fail(
            new ReservedBucket({ message: 'The me bucket cannot be deleted.' }),
          );
        // The guarded delete and its failure classification share one atomic batch.
        const [removed, remaining] = yield* sql
          .batch([
            sql`DELETE FROM buckets WHERE path = ${path} AND NOT EXISTS (SELECT 1 FROM buckets child WHERE substr(child.path, 1, length(${path}) + 1) = ${`${path}/`}) RETURNING path`,
            sql`SELECT path FROM buckets WHERE path = ${path}`,
          ])
          .pipe(unavailable);
        if (removed.length) return;
        if (remaining.length)
          return yield* Effect.fail(
            new BucketHasChildren({
              message: 'Delete its child buckets first.',
            }),
          );
        return yield* Effect.fail(
          new BucketNotFound({ message: 'Bucket not found.' }),
        );
      }),
  };
});
