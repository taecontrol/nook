import { queryOptions } from '@tanstack/react-query';
import { ApiError, runApi } from './api-client';

export type Session =
  | { state: 'signed-in'; email: string }
  | { state: 'loading' | 'session-expired' | 'not-owner' | 'unavailable' };

function failureState(error: unknown): Session {
  // Interruptions and defects are not answers about the session.
  if (!(error instanceof ApiError)) throw error;
  if (error.status === 401) return { state: 'session-expired' };
  if (error.status === 403) return { state: 'not-owner' };
  return { state: 'unavailable' };
}

export const identityOptions = queryOptions({
  queryKey: ['session', 'whoami'],
  queryFn: ({ signal }) =>
    runApi((api) => api.session.whoami(), signal).then(
      (owner): Session => ({ state: 'signed-in', email: owner.email }),
      failureState,
    ),
  staleTime: Infinity,
  gcTime: Infinity,
  retry: false,
  refetchOnWindowFocus: false,
});
