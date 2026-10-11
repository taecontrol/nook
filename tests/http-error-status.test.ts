import { Effect, Schema, SchemaAST } from 'effect';
import { HttpApiError } from 'effect/http-api';
import { expect, it } from 'vitest';
import { runApi } from '../apps/web/src/api-client.ts';
import * as contract from '../packages/contract/src/index.ts';

const contractStatuses = {
  Unauthorized: 401,
  Forbidden: 403,
  ServiceUnavailable: 503,
  InvalidBucketPath: 400,
  ReservedBucket: 400,
  BucketHasChildren: 409,
  BucketNotFound: 404,
  InvalidSecret: 400,
  SecretExists: 409,
  SecretChanged: 409,
  SecretNotFound: 404,
  BucketHasSecrets: 409,
  VaultNotConfigured: 503,
  InvalidMemory: 400,
  MemoryNotFound: 404,
  BucketHasMemories: 409,
  InvalidMemoryCursor: 400,
  InvalidMachineName: 400,
  NoMatchingRequest: 404,
  AlreadyHandled: 409,
  Expired: 410,
  PendingLimit: 429,
  pending: 400,
  denied: 400,
  expired: 400,
  invalid: 400,
  InvalidBucketGrant: 400,
  GrantBucketNotFound: 400,
  InvalidRun: 400,
  SecretsForbidden: 403,
  SecretKeyUnavailable: 503,
  InvalidAuditFilter: 400,
};

function annotatedStatuses() {
  const resolveStatus = SchemaAST.resolveAt<number>('httpApiStatus');
  return Object.fromEntries(
    [
      ...Object.values(contract),
      HttpApiError.Unauthorized,
      HttpApiError.Forbidden,
      HttpApiError.ServiceUnavailable,
    ].flatMap((schema) => {
      if (!Schema.isSchema(schema)) return [];
      const status = resolveStatus(schema.ast);
      if (status === undefined) return [];
      const tagged = schema as unknown as {
        fields: { _tag: { schema: { literal: string } } };
      };
      return [[tagged.fields._tag.schema.literal, status]];
    }),
  );
}

it('pins every annotated contract error, including newly exported errors', () => {
  expect(annotatedStatuses()).toEqual(contractStatuses);
  expect(contract.errorStatus).toEqual(contractStatuses);
});

it('passes through exactly the annotated 400 domain errors', () => {
  expect([...contract.badRequestTags].sort()).toEqual(
    [
      'pending',
      'denied',
      'expired',
      'invalid',
      'InvalidMachineName',
      'InvalidBucketGrant',
      'GrantBucketNotFound',
      'InvalidSecret',
      'InvalidRun',
      'InvalidAuditFilter',
      'InvalidMemory',
      'InvalidMemoryCursor',
      'InvalidBucketPath',
      'ReservedBucket',
    ].sort(),
  );
});

const webStatuses = {
  ...contractStatuses,
  InvalidMachineName: 503,
  NoMatchingRequest: 503,
  AlreadyHandled: 503,
  Expired: 503,
  PendingLimit: 503,
  pending: 503,
  denied: 503,
  expired: 503,
  invalid: 503,
  InvalidBucketGrant: 503,
  GrantBucketNotFound: 503,
  InvalidRun: 503,
  SecretsForbidden: 503,
  UnexpectedFailure: 503,
};
const publicTags = new Set([
  'InvalidSecret',
  'SecretExists',
  'SecretChanged',
  'SecretNotFound',
  'VaultNotConfigured',
  'SecretKeyUnavailable',
  'BucketHasSecrets',
  'BucketHasMemories',
]);
it.each(Object.entries(webStatuses))(
  'the web client preserves %s as %s and exposes only allowlisted messages',
  async (tag, status) => {
    await expect(
      runApi(() => Effect.fail({ _tag: tag, message: 'Domain message.' })),
    ).rejects.toMatchObject({
      status,
      tag,
      outcomeUnknown: tag === 'ServiceUnavailable',
      message: publicTags.has(tag)
        ? 'Domain message.'
        : `Request failed with ${status}`,
    });
  },
);
