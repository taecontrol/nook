import { D1Client } from '@effect/sql-d1';
import {
  type AskFirstMark,
  type BucketGrant,
  InvalidBucketPath,
  InvalidSecret,
  validateBucketPath,
  validateSecretPath,
} from '@nook/contract';
import { Effect, Schema } from 'effect';
import { HttpApiError } from 'effect/http-api';
import { unavailable } from './http-errors.ts';

const Mark = Schema.Struct({
  kind: Schema.Literals(['bucket', 'secret']),
  path: Schema.String,
});
export function marksRead(sql: D1Client.D1Client) {
  return sql<
    typeof Mark.Type
  >`SELECT kind,path FROM ask_first_marks ORDER BY kind,path`;
}
export function marksUnchanged(
  sql: D1Client.D1Client,
  marks: readonly AskFirstMark[],
) {
  const json = JSON.stringify(marks);
  return sql`(SELECT count(*) FROM ask_first_marks)=json_array_length(${json}) AND NOT EXISTS (SELECT 1 FROM json_each(${json}) m WHERE NOT EXISTS (SELECT 1 FROM ask_first_marks a WHERE a.kind=json_extract(m.value,'$.kind') AND a.path=json_extract(m.value,'$.path')))`;
}
export const requireOwner = (grant: BucketGrant) =>
  grant === 'all' ? Effect.void : Effect.fail(new HttpApiError.Forbidden());
function validateMark(mark: AskFirstMark) {
  const message =
    mark.kind === 'bucket'
      ? validateBucketPath(mark.path)
      : validateSecretPath(mark.path);
  if (!message) return Effect.void;
  return Effect.fail(
    mark.kind === 'bucket'
      ? new InvalidBucketPath({ message })
      : new InvalidSecret({ message }),
  );
}
export const askFirstStore = Effect.gen(function* () {
  const sql = yield* D1Client.D1Client;
  return {
    list: () =>
      sql<{
        kind: 'bucket' | 'secret';
        path: string;
        exists: number;
      }>`SELECT kind,path,CASE WHEN kind='bucket' THEN EXISTS(SELECT 1 FROM buckets WHERE buckets.path=a.path) ELSE EXISTS(SELECT 1 FROM secrets WHERE bucket || '/' || name=a.path) END AS "exists" FROM ask_first_marks a ORDER BY kind,path`.pipe(
        unavailable,
        Effect.map((rows) => ({
          marks: rows.map((r) => ({ ...r, exists: !!r.exists })),
        })),
      ),
    put: (mark: AskFirstMark) =>
      validateMark(mark).pipe(
        Effect.andThen(
          sql`INSERT OR IGNORE INTO ask_first_marks(kind,path) VALUES (${mark.kind},${mark.path})`.pipe(
            unavailable,
          ),
        ),
        Effect.asVoid,
      ),
    remove: (mark: AskFirstMark) =>
      validateMark(mark).pipe(
        Effect.andThen(
          sql`DELETE FROM ask_first_marks WHERE kind=${mark.kind} AND path=${mark.path}`.pipe(
            unavailable,
          ),
        ),
        Effect.asVoid,
      ),
  };
});
