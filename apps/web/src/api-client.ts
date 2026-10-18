import {
  Api,
  AuthorizationsApi,
  type BucketGrant,
  errorStatus,
} from '@nook/contract';
import { Effect, Schema } from 'effect';
import { FetchHttpClient, type HttpClient, HttpClientError } from 'effect/http';
import { HttpApiClient } from 'effect/http-api';

export class ApiError extends Error {
  /** The message is one the contract lets the owner read. */
  readonly hasPublicMessage: boolean;
  constructor(
    readonly status: number,
    readonly outcomeUnknown = false,
    readonly tag = 'ServiceUnavailable',
    message?: string,
    readonly current?: BucketGrant,
    readonly ambiguous = false,
  ) {
    super(message ?? `Request failed with ${status}`);
    this.hasPublicMessage = message !== undefined;
  }
}

export function writeOutcome(
  error: unknown,
): 'definitive' | 'unknown' | 'ambiguous' {
  if (!(error instanceof ApiError)) return 'unknown';
  if (error.ambiguous) return 'ambiguous';
  return error.outcomeUnknown || error.tag === 'ServiceUnavailable'
    ? 'unknown'
    : 'definitive';
}

/** Preserve the original public reason after an earlier attempt lost its answer. */
export function ambiguousWrite(failure: unknown) {
  const error = failure instanceof ApiError ? failure : new ApiError(503, true);
  return new ApiError(
    error.status,
    error.outcomeUnknown,
    error.tag,
    error.hasPublicMessage ? error.message : undefined,
    error.current,
    true,
  );
}
// Errors the contract declares carry their status; Cloudflare Access answers
// 401 and 403 before the Worker does; anything else is unavailable.
function statusOf(error: unknown, tag: string) {
  if (Object.hasOwn(errorStatus, tag))
    return errorStatus[tag as keyof typeof errorStatus];
  if (HttpClientError.isHttpClientError(error)) {
    const status = error.response?.status;
    if (status === 401 || status === 403) return status;
  }
  return 503;
}
function apiRunner<Client>(
  client: Effect.Effect<Client, never, HttpClient.HttpClient>,
) {
  return <A, E>(
    operation: (api: Client) => Effect.Effect<A, E>,
    signal?: AbortSignal,
  ) =>
    Effect.runPromise(
      Effect.flatMap(client, operation).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.mapError((failure) => {
          const error = failure as { _tag?: string; current?: BucketGrant };
          const tag = error._tag ?? 'ServiceUnavailable';
          const status = statusOf(error, tag);
          return new ApiError(
            status,
            // Failed delivery or decoding and storage errors can follow commit.
            status !== 401 &&
              status !== 403 &&
              (HttpClientError.isHttpClientError(error) ||
                Schema.isSchemaError(error) ||
                tag === 'ServiceUnavailable'),
            tag,
            publicMessage(error),
            tag === 'MachineAccessChanged' ? error.current : undefined,
          );
        }),
      ),
      { signal },
    );
}
export const runApi = apiRunner(HttpApiClient.make(Api));
export const runAuthorizationsApi = apiRunner(
  HttpApiClient.make(AuthorizationsApi),
);
/**
 * What the owner reads when a request fails. `action` completes "Only this
 * installation's owner can …". `outcome` follows every reason; without it,
 * an unavailable Nook asks the owner to try again in a moment.
 */
export function describeFailure(
  error: unknown,
  action: string,
  outcome?: string,
) {
  const status = error instanceof ApiError ? error.status : 503;
  if (status === 401)
    return joined(
      'Your owner session expired. Sign in again, then try again.',
      outcome,
    );
  if (status === 403)
    return joined(`Only this installation’s owner can ${action}.`, outcome);
  if (error instanceof ApiError && error.hasPublicMessage)
    return joined(error.message, outcome);
  return joined(
    'Nook is unavailable right now.',
    outcome ?? 'Try again in a moment.',
  );
}
function joined(reason: string, outcome: string | undefined) {
  return outcome ? `${reason} ${outcome}` : reason;
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
    'MemoryChanged',
  ].includes(typed._tag ?? '')
    ? typed.message
    : undefined;
}
