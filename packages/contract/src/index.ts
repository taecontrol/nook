import { Schema } from 'effect';
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
} from 'effect/http-api';
import {
  Bucket,
  BucketHasChildren,
  BucketNotFound,
  CreatedBucket,
  InvalidBucketPath,
  ReservedBucket,
} from './buckets.ts';

export * from './buckets.ts';
export * from './machines.ts';
export const Owner = Schema.Struct({ email: Schema.String });
export type Owner = typeof Owner.Type;
const errors = [
  HttpApiError.Unauthorized,
  HttpApiError.Forbidden,
  HttpApiError.ServiceUnavailable,
];
export const Api = HttpApi.make('nook')
  .add(
    HttpApiGroup.make('session').add(
      HttpApiEndpoint.get('whoami', '/api/whoami', {
        success: Owner,
        error: [HttpApiError.Unauthorized, HttpApiError.Forbidden],
      }),
    ),
  )
  .add(
    HttpApiGroup.make('buckets')
      .add(
        HttpApiEndpoint.get('list', '/api/buckets', {
          success: Schema.Struct({ buckets: Schema.Array(Bucket) }),
          error: errors,
        }),
      )
      .add(
        HttpApiEndpoint.post('create', '/api/buckets', {
          payload: Schema.Struct({ path: Schema.String }),
          success: CreatedBucket,
          error: [...errors, InvalidBucketPath],
        }),
      )
      .add(
        HttpApiEndpoint.delete('delete', '/api/buckets/:path', {
          params: Schema.Struct({ path: Schema.String }),
          success: Schema.Void.annotate({ httpApiStatus: 204 }),
          error: [
            ...errors,
            InvalidBucketPath,
            ReservedBucket,
            BucketHasChildren,
            BucketNotFound,
          ],
        }),
      ),
  );
