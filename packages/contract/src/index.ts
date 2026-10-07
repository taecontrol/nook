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
import { Machine } from './machines.ts';
import {
  BucketHasSecrets,
  CreateSecret,
  InvalidSecret,
  OwnerSecret,
  ReplaceSecret,
  SecretChanged,
  SecretExists,
  SecretNotFound,
  VaultNotConfigured,
  WriteId,
} from './vault.ts';

export * from './buckets.ts';
export * from './grants.ts';
export * from './machines.ts';
export * from './vault.ts';
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
            BucketHasSecrets,
            BucketNotFound,
          ],
        }),
      ),
  )
  .add(
    HttpApiGroup.make('vault')
      .add(
        HttpApiEndpoint.get('list', '/api/secrets', {
          success: Schema.Struct({ secrets: Schema.Array(OwnerSecret) }),
          error: errors,
        }),
      )
      .add(
        HttpApiEndpoint.post('create', '/api/secrets', {
          payload: CreateSecret,
          success: OwnerSecret.annotate({ httpApiStatus: 201 }),
          error: [
            ...errors,
            InvalidBucketPath,
            InvalidSecret,
            BucketNotFound,
            SecretExists,
            VaultNotConfigured,
          ],
        }),
      )
      .add(
        HttpApiEndpoint.put('replace', '/api/secrets/:path', {
          params: Schema.Struct({ path: Schema.String }),
          payload: ReplaceSecret,
          success: OwnerSecret,
          error: [
            ...errors,
            InvalidBucketPath,
            InvalidSecret,
            SecretNotFound,
            SecretChanged,
            VaultNotConfigured,
          ],
        }),
      )
      .add(
        HttpApiEndpoint.delete('remove', '/api/secrets/:path', {
          params: Schema.Struct({ path: Schema.String }),
          query: Schema.Struct({ version: WriteId }),
          success: Schema.Void.annotate({ httpApiStatus: 204 }),
          error: [
            ...errors,
            InvalidBucketPath,
            InvalidSecret,
            SecretNotFound,
            SecretChanged,
          ],
        }),
      ),
  )
  .add(
    HttpApiGroup.make('machines')
      .add(
        HttpApiEndpoint.get('list', '/api/machines', {
          success: Schema.Struct({ machines: Schema.Array(Machine) }),
          error: errors,
        }),
      )
      .add(
        HttpApiEndpoint.delete('revoke', '/api/machines/:id', {
          params: Schema.Struct({ id: Schema.String }),
          success: Schema.Void.annotate({ httpApiStatus: 204 }),
          error: errors,
        }),
      ),
  );
