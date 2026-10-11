import { Api, errorStatus } from '@nook/contract';
import { Effect, Schema } from 'effect';
import { FetchHttpClient, HttpClientError } from 'effect/http';
import { HttpApiClient } from 'effect/http-api';

export class ApiError extends Error {
  ambiguous = false;
  constructor(
    readonly status: number,
    readonly outcomeUnknown = false,
    readonly tag = 'ServiceUnavailable',
    message?: string,
  ) {
    super(message ?? `Request failed with ${status}`);
  }
}
// Errors the owner API declares carry their contract status; anything else is unavailable.
function statusOf(tag: string) {
  return Object.hasOwn(errorStatus, tag)
    ? errorStatus[tag as keyof typeof errorStatus]
    : 503;
}
const client = HttpApiClient.make(Api);
export function runApi<A, E>(
  operation: (api: Effect.Success<typeof client>) => Effect.Effect<A, E>,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    Effect.flatMap(client, operation).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.mapError(
        (error) =>
          new ApiError(
            statusOf((error as { _tag: string })._tag),
            // Failed delivery or decoding and storage errors can follow commit.
            HttpClientError.isHttpClientError(error) ||
              Schema.isSchemaError(error) ||
              (error as { _tag: string })._tag === 'ServiceUnavailable',
            (error as { _tag?: string })._tag ?? 'ServiceUnavailable',
            publicMessage(error),
          ),
      ),
    ),
    { signal },
  );
}
function publicMessage(error: unknown) {
  const typed = error as { _tag?: string; message?: string };
  return [
    'InvalidSecret',
    'SecretExists',
    'SecretChanged',
    'SecretNotFound',
    'VaultNotConfigured',
    'SecretKeyUnavailable',
    'BucketHasSecrets',
    'BucketHasMemories',
  ].includes(typed._tag ?? '')
    ? typed.message
    : undefined;
}
