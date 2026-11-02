import { Schema } from 'effect';
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
} from 'effect/http-api';
import {
  ApprovalAlreadyHandled,
  ApprovalList,
  ApprovalView,
  AskFirstList,
  AskFirstMark,
  Remember,
} from './approvals.ts';
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
import { Expired, Machine, MachineAccessChanged } from './machines.ts';
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

export * from './agent-session.ts';
export {
  ApprovalAlreadyHandled,
  ApprovalAttempt,
  ApprovalDenied,
  ApprovalExpired,
  ApprovalLimit,
  ApprovalList,
  ApprovalPending,
  ApprovalReference,
  ApprovalView,
  AskFirstList,
  AskFirstMark,
  coveringMark,
  Remember as ApprovalRemember,
  rememberDuration,
} from './approvals.ts';
export * from './audit.ts';
export * from './buckets.ts';
export * from './env-import.ts';
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
    HttpApiGroup.make('askFirst')
      .add(
        HttpApiEndpoint.get('list', '/api/ask-first', {
          success: AskFirstList,
          error: errors,
        }),
      )
      .add(
        HttpApiEndpoint.put('put', '/api/ask-first/:kind/:path', {
          params: AskFirstMark,
          success: Schema.Void.annotate({ httpApiStatus: 204 }),
          error: [...errors, InvalidBucketPath, InvalidSecret],
        }),
      )
      .add(
        HttpApiEndpoint.delete('remove', '/api/ask-first/:kind/:path', {
          params: AskFirstMark,
          success: Schema.Void.annotate({ httpApiStatus: 204 }),
          error: [...errors, InvalidBucketPath, InvalidSecret],
        }),
      ),
  )
  .add(
    HttpApiGroup.make('approvals')
      .add(
        HttpApiEndpoint.get('list', '/api/approvals', {
          success: ApprovalList,
          error: errors,
        }),
      )
      .add(
        HttpApiEndpoint.get('get', '/api/approvals/:id', {
          params: Schema.Struct({ id: Schema.String }),
          success: ApprovalView,
          error: [...errors, HttpApiError.NotFound],
        }),
      )
      .add(
        HttpApiEndpoint.post('approve', '/api/approvals/:id/approve', {
          params: Schema.Struct({ id: Schema.String }),
          payload: Schema.Struct({ remember: Remember }),
          success: ApprovalView,
          error: [
            ...errors,
            HttpApiError.NotFound,
            Expired,
            ApprovalAlreadyHandled,
          ],
        }),
      )
      .add(
        HttpApiEndpoint.post('deny', '/api/approvals/:id/deny', {
          params: Schema.Struct({ id: Schema.String }),
          success: ApprovalView,
          error: [
            ...errors,
            HttpApiError.NotFound,
            Expired,
            ApprovalAlreadyHandled,
          ],
        }),
      ),
  )
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
