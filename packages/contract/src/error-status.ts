import { type Schema, SchemaAST } from 'effect';
import { HttpApiError } from 'effect/http-api';
import { InvalidAuditFilter } from './audit.ts';
import {
  BucketHasChildren,
  BucketNotFound,
  InvalidBucketPath,
  ReservedBucket,
} from './buckets.ts';
import { GrantBucketNotFound, InvalidBucketGrant } from './grants.ts';
import {
  AlreadyHandled,
  Expired,
  InvalidMachineName,
  NoMatchingRequest,
  PendingLimit,
  PollDenied,
  PollExpired,
  PollInvalid,
  PollPending,
} from './machines.ts';
import {
  BucketHasMemories,
  InvalidMemory,
  InvalidMemoryCursor,
  MemoryNotFound,
} from './memory.ts';
import { InvalidRun, SecretKeyUnavailable, SecretsForbidden } from './run.ts';
import {
  BucketHasSecrets,
  InvalidSecret,
  SecretChanged,
  SecretExists,
  SecretNotFound,
  VaultNotConfigured,
} from './vault.ts';

const errors = [
  HttpApiError.Unauthorized,
  HttpApiError.Forbidden,
  HttpApiError.ServiceUnavailable,
  InvalidBucketPath,
  ReservedBucket,
  BucketHasChildren,
  BucketNotFound,
  InvalidSecret,
  SecretExists,
  SecretChanged,
  SecretNotFound,
  BucketHasSecrets,
  VaultNotConfigured,
  InvalidMemory,
  MemoryNotFound,
  BucketHasMemories,
  InvalidMemoryCursor,
  InvalidMachineName,
  NoMatchingRequest,
  AlreadyHandled,
  Expired,
  PendingLimit,
  PollPending,
  PollDenied,
  PollExpired,
  PollInvalid,
  InvalidBucketGrant,
  GrantBucketNotFound,
  InvalidRun,
  SecretsForbidden,
  SecretKeyUnavailable,
  InvalidAuditFilter,
] as const;
type ErrorTag = (typeof errors)[number]['Type']['_tag'];

function annotatedStatus(schema: Schema.Top) {
  const status = SchemaAST.resolveAt<number>('httpApiStatus')(schema.ast);
  if (status === undefined)
    throw new Error('Domain errors must declare an HTTP status.');
  return status;
}

export const errorStatus = Object.fromEntries(
  errors.map((schema) => [
    schema.fields._tag.schema.literal,
    annotatedStatus(schema),
  ]),
) as Record<ErrorTag, number>;

export const badRequestTags = new Set(
  Object.entries(errorStatus)
    .filter(([, status]) => status === 400)
    .map(([tag]) => tag),
);
