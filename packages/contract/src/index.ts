import { Schema } from 'effect';
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
} from 'effect/http-api';
import { AuditFilters, AuditPage, InvalidAuditFilter } from './audit.ts';
import {
  Bucket,
  BucketHasChildren,
  BucketNotFound,
  CreatedBucket,
  InvalidBucketPath,
  ReservedBucket,
} from './buckets.ts';
import { GrantBucketNotFound, InvalidBucketGrant } from './grants.ts';
import { Machine, MachineAccessChanged } from './machines.ts';
import {
  BucketHasMemories,
  InvalidMemory,
  InvalidMemoryCursor,
  InvalidMemorySearch,
  MemoryChanged,
  MemoryCounts,
  MemoryHistory,
  MemoryHistoryQuery,
  MemoryNotFound,
  MemoryPage,
  MemoryQuery,
  MemorySearchQuery,
  OwnerMemory,
  OwnerMemorySearchResults,
} from './memory.ts';
import {
  FileNotFound,
  FileParams,
  FileStream,
  InvalidFile,
} from './memory-files.ts';
import { SecretKeyUnavailable } from './run.ts';
import {
  BucketHasSecrets,
  CreateSecret,
  InvalidSecret,
  OwnerSecret,
  ReplaceSecret,
  SecretChanged,
  SecretExists,
  SecretNotFound,
  SecretValue,
  VaultNotConfigured,
  WriteId,
} from './vault.ts';

export * from './audit.ts';
export * from './buckets.ts';
export * from './error-status.ts';
export * from './grants.ts';
export * from './machines.ts';
export * from './memory.ts';
export * from './memory-files.ts';
export * from './run.ts';
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
    HttpApiGroup.make('memories')
      .add(
        HttpApiEndpoint.delete('forget', '/api/memories/:id', {
          params: Schema.Struct({ id: Schema.String }),
          query: Schema.Struct({
            expectedVersion: Schema.optionalKey(Schema.String),
          }),
          success: Schema.Void.annotate({ httpApiStatus: 204 }),
          error: [...errors, MemoryNotFound, MemoryChanged, InvalidMemory],
        }),
      )
      .add(
        HttpApiEndpoint.get('history', '/api/memories/:id/versions', {
          params: Schema.Struct({ id: Schema.String }),
          query: MemoryHistoryQuery,
          success: MemoryHistory,
          error: [...errors, MemoryNotFound, InvalidMemoryCursor],
        }),
      )
      .add(
        HttpApiEndpoint.get('search', '/api/memories/search', {
          query: MemorySearchQuery,
          success: OwnerMemorySearchResults,
          error: [
            ...errors,
            InvalidBucketPath,
            InvalidMemorySearch,
            BucketNotFound,
          ],
        }),
      )
      .add(
        HttpApiEndpoint.get('counts', '/api/memories/counts', {
          success: MemoryCounts,
          error: errors,
        }),
      )
      .add(
        HttpApiEndpoint.get('list', '/api/memories', {
          query: MemoryQuery,
          success: MemoryPage,
          error: [
            ...errors,
            InvalidBucketPath,
            InvalidMemoryCursor,
            BucketNotFound,
          ],
        }),
      )
      .add(
        HttpApiEndpoint.get('get', '/api/memories/:id', {
          params: Schema.Struct({ id: Schema.String }),
          success: OwnerMemory,
          error: [...errors, MemoryNotFound],
        }),
      )
      .add(
        HttpApiEndpoint.get('downloadFile', '/api/memories/:id/files/:name', {
          params: FileParams,
          success: FileStream,
          error: [...errors, MemoryNotFound, FileNotFound, InvalidFile],
        }),
      ),
  )
  .add(
    HttpApiGroup.make('audit').add(
      HttpApiEndpoint.get('list', '/api/audit', {
        query: AuditFilters,
        success: AuditPage,
        error: [...errors, InvalidAuditFilter],
      }),
    ),
  )
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
            BucketHasMemories,
            BucketNotFound,
          ],
        }),
      ),
  )
  .add(
    HttpApiGroup.make('vault')
      .add(
        HttpApiEndpoint.post('reveal', '/api/secrets/:path/reveal', {
          params: Schema.Struct({ path: Schema.String }),
          success: Schema.Struct({ value: SecretValue }),
          error: [
            ...errors,
            InvalidBucketPath,
            InvalidSecret,
            SecretNotFound,
            VaultNotConfigured,
            SecretKeyUnavailable,
          ],
        }),
      )
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
        HttpApiEndpoint.put('saveGrant', '/api/machines/:id/grant', {
          params: Schema.Struct({ id: Schema.String }),
          payload: Schema.Struct({
            grant: Schema.Unknown,
            previous: Schema.Unknown,
          }),
          success: Machine,
          error: [
            ...errors,
            InvalidBucketGrant,
            GrantBucketNotFound,
            MachineAccessChanged,
            HttpApiError.NotFound,
          ],
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
