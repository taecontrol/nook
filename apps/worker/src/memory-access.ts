import { D1Client } from '@effect/sql-d1';
import {
  type BucketGrant,
  canRead,
  canWrite,
  MemoryNotFound,
} from '@nook/contract';
import { Effect } from 'effect';
import { HttpApiError } from 'effect/http-api';
import { unavailable } from './http-errors.ts';

export const memoryUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const memoryNotFound = () =>
  new MemoryNotFound({ message: 'Memory not found.' });

export function bucketFor(grant: BucketGrant, id: string, write = false) {
  return Effect.gen(function* () {
    if (!memoryUuid.test(id)) return yield* Effect.fail(memoryNotFound());
    const sql = yield* D1Client.D1Client;
    const heads = yield* sql<{
      bucket: string;
    }>`SELECT bucket FROM memories WHERE id=${id}`.pipe(unavailable);
    const bucket = heads[0]?.bucket;
    if (!bucket || !canRead(grant, bucket))
      return yield* Effect.fail(memoryNotFound());
    if (write && !canWrite(grant, bucket))
      return yield* Effect.fail(new HttpApiError.Forbidden());
    return bucket;
  });
}
