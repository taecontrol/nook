import { Api } from '@nook/contract';
import { queryOptions } from '@tanstack/react-query';
import { Effect } from 'effect';
import { FetchHttpClient, HttpClientError } from 'effect/http';
import { HttpApiClient } from 'effect/http-api';

export type Session =
  | { state: 'signed-in'; email: string }
  | { state: 'loading' | 'session-expired' | 'not-owner' | 'unavailable' };

const loadIdentity = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(Api);
  return yield* client.session.whoami();
}).pipe(Effect.provide(FetchHttpClient.layer));

function failureState(error: { _tag: string }): Session {
  if (HttpClientError.isHttpClientError(error)) {
    if (error.response?.status === 401) return { state: 'session-expired' };
    if (error.response?.status === 403) return { state: 'not-owner' };
  }
  if (error._tag === 'Unauthorized') return { state: 'session-expired' };
  if (error._tag === 'Forbidden') return { state: 'not-owner' };
  return { state: 'unavailable' };
}

export const identityOptions = queryOptions({
  queryKey: ['session', 'whoami'],
  queryFn: ({ signal }) =>
    Effect.runPromise(
      loadIdentity.pipe(
        Effect.match({
          onSuccess: (owner): Session => ({
            state: 'signed-in',
            email: owner.email,
          }),
          onFailure: failureState,
        }),
      ),
      { signal },
    ),
  staleTime: Infinity,
  gcTime: Infinity,
  retry: false,
  refetchOnWindowFocus: false,
});
