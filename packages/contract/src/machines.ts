import { Schema } from 'effect';
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
} from 'effect/http-api';

import {
  BucketGrant,
  GrantBucketNotFound,
  InvalidBucketGrant,
} from './grants.ts';
export const MachineIdentity = Schema.Struct({
  machine: Schema.String,
  grant: BucketGrant,
});
export type MachineIdentity = typeof MachineIdentity.Type;
export const Machine = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  approvedAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
  grant: BucketGrant,
});
export type Machine = typeof Machine.Type;
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
export function machineNameError(name: string) {
  if (!name.trim()) return 'Enter a name for this machine.';
  if (name.trim().length > 64)
    return 'Use at most 64 characters for the machine name.';
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
const machineErrors = [
  HttpApiError.Unauthorized,
  HttpApiError.ServiceUnavailable,
];
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
          suggestedName: Schema.String.check(Schema.isMaxLength(64)),
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
      HttpApiEndpoint.delete('logout', '/api/machine/token', {
        success: noContent,
        error: machineErrors,
        headers: Schema.Struct({ authorization: Schema.String }),
      }),
    ),
);
