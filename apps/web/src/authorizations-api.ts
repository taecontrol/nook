import { type AuthorizationRequest, AuthorizationsApi } from '@nook/contract';
import { useQueryClient } from '@tanstack/react-query';
import { Effect } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { HttpApiClient } from 'effect/http-api';
import { useEffect, useState } from 'react';

class ApprovalError extends Error {
  constructor(readonly tag: string) {
    super('The authorization request could not be completed.');
  }
}
const client = HttpApiClient.make(AuthorizationsApi);
function run<A, E>(
  operation: (api: Effect.Success<typeof client>) => Effect.Effect<A, E>,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    Effect.flatMap(client, operation).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.mapError(
        (error) =>
          new ApprovalError((error as { _tag?: string })._tag ?? 'Unavailable'),
      ),
    ),
    { signal },
  );
}
export type AuthorizationPhase =
  | 'code'
  | 'checking'
  | 'request'
  | 'approving'
  | 'denying'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'used';
function terminalPhase(error: unknown) {
  if (!(error instanceof ApprovalError)) return undefined;
  if (error.tag === 'Expired') return 'expired';
  if (error.tag === 'AlreadyHandled') return 'used';
}
function approvalFailure(
  error: unknown,
  fallback: 'code' | 'request',
): { phase: AuthorizationPhase; failure: 'unknown' | 'network' | undefined } {
  const terminal = terminalPhase(error);
  if (terminal) return { phase: terminal, failure: undefined };
  const missing =
    error instanceof ApprovalError && error.tag === 'NoMatchingRequest';
  return {
    phase: missing ? 'code' : fallback,
    failure: missing ? 'unknown' : 'network',
  };
}
export function useAuthorizationFlow() {
  const queries = useQueryClient();
  const [phase, setPhase] = useState<AuthorizationPhase>('code');
  const [request, setRequest] = useState<AuthorizationRequest>();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [failure, setFailure] = useState<'unknown' | 'network'>();
  async function lookup() {
    setFailure(undefined);
    setPhase('checking');
    try {
      const request = await queries.fetchQuery({
        queryKey: ['authorization', code],
        queryFn: ({ signal }) =>
          run(
            (api) => api.authorizations.lookup({ params: { userCode: code } }),
            signal,
          ),
        staleTime: 0,
        retry: false,
      });
      setRequest(request);
      setName(request.suggestedName);
      setPhase('request');
    } catch (error) {
      const failed = approvalFailure(error, 'code');
      setPhase(failed.phase);
      setFailure(failed.failure);
    }
  }
  async function decide(action: 'approve' | 'deny') {
    setFailure(undefined);
    setPhase(action === 'approve' ? 'approving' : 'denying');
    try {
      await run((api) =>
        action === 'approve'
          ? api.authorizations.approve({
              params: { userCode: code },
              payload: { machineName: name },
            })
          : api.authorizations.deny({ params: { userCode: code } }),
      );
      queries.removeQueries({ queryKey: ['authorization', code] });
      setName(name.trim());
      setPhase(action === 'approve' ? 'approved' : 'denied');
    } catch (error) {
      queries.removeQueries({ queryKey: ['authorization', code] });
      const failed = approvalFailure(error, 'request');
      setPhase(failed.phase);
      setFailure(failed.failure);
    }
  }
  useEffect(
    () => () => {
      queries.removeQueries({ queryKey: ['authorization', code], exact: true });
    },
    [code, queries],
  );
  useEffect(() => {
    if (phase !== 'request' || !request) return;
    const timer = setTimeout(
      () => setPhase('expired'),
      Math.max(0, Date.parse(request.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [phase, request]);
  return {
    phase,
    request,
    code,
    setCode,
    name,
    setName,
    failure,
    lookup,
    decide,
    changeCode: () => {
      queries.removeQueries({ queryKey: ['authorization', code] });
      setFailure(undefined);
      setPhase('code');
    },
  };
}
