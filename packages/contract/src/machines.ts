import { Schema } from 'effect';
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
} from 'effect/http-api';
import {
  ApprovalDenied,
  ApprovalExpired,
  ApprovalLimit,
  ApprovalPending,
} from './approvals.ts';
import { BucketNotFound, InvalidBucketPath } from './buckets.ts';
import {
  BucketGrant,
  GrantBucketNotFound,
  InvalidBucketGrant,
} from './grants.ts';
import { MemoryNotFound } from './memory.ts';
import {
  FileAttached,
  FileBytes,
  FileNotFound,
  FileParams,
  FileQuotaExceeded,
  FileStream,
  FileTooLarge,
  InvalidFile,
} from './memory-files.ts';
import {
  CreateMachineSecret,
  DeliveredSecrets,
  InvalidRun,
  RunSecrets,
  SecretKeyUnavailable,
  SecretsForbidden,
} from './run.ts';
import {
  InvalidSecret,
  Secret,
  SecretExists,
  SecretNotFound,
  VaultNotConfigured,
} from './vault.ts';
export const AccessLifetime = Schema.Literals([
  '1d',
  '7d',
  '30d',
  '90d',
  'never',
]);
export type AccessLifetime = typeof AccessLifetime.Type;
const dayMs = 86_400_000;
export const accessLifetimeMs: Record<AccessLifetime, number | null> = {
  '1d': dayMs,
  '7d': 7 * dayMs,
  '30d': 30 * dayMs,
  '90d': 90 * dayMs,
  never: null,
};
export class MachineUnauthorized extends Schema.Error<MachineUnauthorized>(
  'nook/MachineUnauthorized',
)(
  {
    _tag: Schema.tag('Unauthorized'),
    expiredAt: Schema.optionalKey(Schema.String),
  },
  { httpApiStatus: 401 },
) {}
export const MachineIdentity = Schema.Struct({
  machine: Schema.String,
  grant: BucketGrant,
  expiresAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type MachineIdentity = typeof MachineIdentity.Type;
export const Machine = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  approvedAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.String),
  grant: BucketGrant,
});
export type Machine = typeof Machine.Type;
export class MachineAccessChanged extends Schema.Error<MachineAccessChanged>(
  'nook/MachineAccessChanged',
)(
  { _tag: Schema.tag('MachineAccessChanged'), current: BucketGrant },
  { httpApiStatus: 409 },
) {}
export const AuthorizationRequest = Schema.Struct({
  suggestedName: Schema.String,
  client: Schema.String,
  requestedAt: Schema.String,
  expiresAt: Schema.String,
});
export type AuthorizationRequest = typeof AuthorizationRequest.Type;
export function normalizeUserCode(value: string) {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
}
export function formatUserCode(value: string) {
  return value.length > 4 ? `${value.slice(0, 4)}-${value.slice(4)}` : value;
}
export const machineNameMaxLength = 64;
export function machineNameError(name: string) {
  if (!name.trim()) return 'Enter a name for this machine.';
  if (name.trim().length > machineNameMaxLength)
    return `Use at most ${machineNameMaxLength} characters for the machine name.`;
}
export class InvalidMachineName extends Schema.Error<InvalidMachineName>(
  'nook/InvalidMachineName',
)(
  { _tag: Schema.tag('InvalidMachineName'), message: Schema.String },
  { httpApiStatus: 400 },
) {}
export class NoMatchingRequest extends Schema.Error<NoMatchingRequest>(
  'nook/NoMatchingRequest',
)({ _tag: Schema.tag('NoMatchingRequest') }, { httpApiStatus: 404 }) {}
export class AlreadyHandled extends Schema.Error<AlreadyHandled>(
  'nook/AlreadyHandled',
)({ _tag: Schema.tag('AlreadyHandled') }, { httpApiStatus: 409 }) {}
export class Expired extends Schema.Error<Expired>('nook/Expired')(
  { _tag: Schema.tag('Expired') },
  { httpApiStatus: 410 },
) {}
export class PendingLimit extends Schema.Error<PendingLimit>(
  'nook/PendingLimit',
)({ _tag: Schema.tag('PendingLimit') }, { httpApiStatus: 429 }) {}
export class PollPending extends Schema.Error<PollPending>('nook/PollPending')(
  { _tag: Schema.tag('pending') },
  { httpApiStatus: 400 },
) {}
export class PollDenied extends Schema.Error<PollDenied>('nook/PollDenied')(
  { _tag: Schema.tag('denied') },
  { httpApiStatus: 400 },
) {}
export class PollExpired extends Schema.Error<PollExpired>('nook/PollExpired')(
  { _tag: Schema.tag('expired') },
  { httpApiStatus: 400 },
) {}
export class PollInvalid extends Schema.Error<PollInvalid>('nook/PollInvalid')(
  { _tag: Schema.tag('invalid') },
  { httpApiStatus: 400 },
) {}
const noContent = Schema.Void.annotate({ httpApiStatus: 204 });
const machineErrors = [MachineUnauthorized, HttpApiError.ServiceUnavailable];
const ownerErrors = [
  HttpApiError.Unauthorized,
  HttpApiError.Forbidden,
  HttpApiError.ServiceUnavailable,
  NoMatchingRequest,
  AlreadyHandled,
  Expired,
];
const params = Schema.Struct({ userCode: Schema.String });
export const AuthorizationsApi = HttpApi.make('owner-authorizations').add(
  HttpApiGroup.make('authorizations')
    .add(
      HttpApiEndpoint.get('lookup', '/api/authorizations/:userCode', {
        params,
        success: AuthorizationRequest,
        error: ownerErrors,
      }),
    )
    .add(
      HttpApiEndpoint.post('approve', '/api/authorizations/:userCode/approve', {
        params,
        payload: Schema.Struct({
          machineName: Schema.String,
          grant: Schema.Unknown,
          lifetime: Schema.optionalKey(AccessLifetime),
        }),
        success: noContent,
        error: [
          ...ownerErrors,
          InvalidMachineName,
          InvalidBucketGrant,
          GrantBucketNotFound,
        ],
      }),
    )
    .add(
      HttpApiEndpoint.post('deny', '/api/authorizations/:userCode/deny', {
        params,
        success: noContent,
        error: ownerErrors,
      }),
    ),
);
export const MachineApi = HttpApi.make('machine').add(
  HttpApiGroup.make('machine')
    .add(
      HttpApiEndpoint.post('authorize', '/api/machine/authorizations', {
        payload: Schema.Struct({
          suggestedName: Schema.String.check(
            Schema.isMaxLength(machineNameMaxLength),
          ),
          client: Schema.String.check(Schema.isMaxLength(128)),
        }),
        success: Schema.Struct({
          deviceCode: Schema.String,
          userCode: Schema.String,
          verificationUrl: Schema.String,
          expiresIn: Schema.Number,
          interval: Schema.Number,
        }),
        error: [PendingLimit, HttpApiError.ServiceUnavailable],
      }),
    )
    .add(
      HttpApiEndpoint.post('poll', '/api/machine/token', {
        payload: Schema.Struct({
          deviceCode: Schema.String.check(Schema.isMaxLength(128)),
        }),
        success: Schema.Struct({
          token: Schema.String,
          machine: Schema.String,
          grant: BucketGrant,
        }),
        error: [
          PollPending,
          PollDenied,
          PollExpired,
          PollInvalid,
          HttpApiError.ServiceUnavailable,
        ],
      }),
    )
    .add(
      HttpApiEndpoint.get('whoami', '/api/machine/whoami', {
        success: MachineIdentity,
        error: machineErrors,
        headers: Schema.Struct({ authorization: Schema.String }),
      }),
    )
    .add(
      HttpApiEndpoint.get('secrets', '/api/machine/secrets', {
        headers: Schema.Struct({ authorization: Schema.String }),
        query: Schema.Struct({ bucket: Schema.String }),
        success: Schema.Struct({ secrets: Schema.Array(Secret) }),
        error: [
          ...machineErrors,
          HttpApiError.Forbidden,
          InvalidBucketPath,
          BucketNotFound,
        ],
      }),
    )
    .add(
      HttpApiEndpoint.post('createSecret', '/api/machine/secrets', {
        headers: Schema.Struct({ authorization: Schema.String }),
        payload: CreateMachineSecret,
        success: Secret.annotate({ httpApiStatus: 201 }),
        error: [
          ...machineErrors,
          HttpApiError.Forbidden,
          BucketNotFound,
          InvalidSecret,
          InvalidRun,
          SecretExists,
          VaultNotConfigured,
        ],
      }),
    )
    .add(
      HttpApiEndpoint.post('values', '/api/machine/secrets/values', {
        headers: Schema.Struct({ authorization: Schema.String }),
        payload: RunSecrets,
        success: Schema.Union([DeliveredSecrets, ApprovalPending]),
        error: [
          ...machineErrors,
          InvalidRun,
          SecretsForbidden,
          ApprovalDenied,
          ApprovalExpired,
          ApprovalLimit,
          SecretNotFound,
          SecretKeyUnavailable,
          VaultNotConfigured,
        ],
      }),
    )
    .add(
      HttpApiEndpoint.put(
        'attachFile',
        '/api/machine/memories/:id/files/:name',
        {
          headers: Schema.Struct({
            authorization: Schema.String,
            'content-type': Schema.String,
          }),
          params: FileParams,
          payload: FileBytes,
          success: FileAttached,
          error: [
            ...machineErrors,
            HttpApiError.Forbidden,
            MemoryNotFound,
            InvalidFile,
            FileTooLarge,
            FileQuotaExceeded,
          ],
        },
      ),
    )
    .add(
      HttpApiEndpoint.get(
        'downloadFile',
        '/api/machine/memories/:id/files/:name',
        {
          headers: Schema.Struct({ authorization: Schema.String }),
          params: FileParams,
          success: FileStream,
          error: [
            ...machineErrors,
            HttpApiError.Forbidden,
            MemoryNotFound,
            FileNotFound,
            InvalidFile,
          ],
        },
      ),
    )
    .add(
      HttpApiEndpoint.delete('withdraw', '/api/machine/approvals/:id', {
        params: Schema.Struct({ id: Schema.String }),
        headers: Schema.Struct({ authorization: Schema.String }),
        success: noContent,
        error: machineErrors,
      }),
    )
    .add(
      HttpApiEndpoint.delete('logout', '/api/machine/token', {
        success: noContent,
        error: machineErrors,
        headers: Schema.Struct({ authorization: Schema.String }),
      }),
    ),
);
