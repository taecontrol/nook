import type { OwnerSecret } from '@nook/contract';
import {
  type QueryClient,
  queryOptions,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Redacted } from 'effect';
import { useRef } from 'react';
import { ApiError, runApi } from './api-client';
import { preloadBuckets } from './buckets-api';
import type { WriteOp } from './vault-state';

export const secretsOptions = queryOptions({
  queryKey: ['vault', 'secrets'],
  queryFn: async ({ signal }) => [
    ...(await runApi((api) => api.vault.list(), signal)).secrets,
  ],
  retry: false,
  staleTime: 30_000,
  // Keep the successful-list revision stable across route unmounts.
  gcTime: Infinity,
  refetchOnWindowFocus: 'always',
  structuralSharing: false,
});
const writeKey = ['vault', 'write'] as const;
export type SecretWrite = {
  op: WriteOp;
  secret: OwnerSecret;
  writeId: string;
  expectedVersion: string;
};
type WriteResult = { secret: OwnerSecret | null; message?: string };
export type ObservedWrite = {
  id: number;
  input: SecretWrite;
  status: 'idle' | 'pending' | 'success' | 'error';
  error: Error | null;
  result: WriteResult | undefined;
  revision: number;
};
function without(secrets: readonly OwnerSecret[], path: string) {
  return secrets.filter((secret) => secret.path !== path);
}
export function unconfirmed(error: Error | null) {
  return (
    error instanceof ApiError &&
    (error.outcomeUnknown ||
      error.tag === 'ServiceUnavailable' ||
      error.ambiguous)
  );
}
function sendOnce(write: SecretWrite, value: Redacted.Redacted<string>) {
  const { secret, op, writeId, expectedVersion } = write;
  if (op === 'delete')
    return runApi((api) =>
      api.vault.remove({
        params: { path: secret.path },
        query: { version: expectedVersion },
      }),
    ).then((): WriteResult => ({ secret: null }));
  const payload = { value, writeId, description: secret.description };
  if (op === 'create')
    return runApi((api) =>
      api.vault.create({
        payload: { ...payload, bucket: secret.bucket, name: secret.name },
      }),
    ).then((stored): WriteResult => ({ secret: stored }));
  return runApi((api) =>
    api.vault.replace({
      params: { path: secret.path },
      payload: { ...payload, expectedVersion },
    }),
  ).then((stored): WriteResult => ({ secret: stored }));
}
function negativeReply(
  write: SecretWrite,
  error: ApiError,
  ambiguous: boolean,
): WriteResult {
  if (!ambiguous && write.op === 'delete' && error.tag === 'SecretNotFound')
    return {
      secret: null,
      message: `${write.secret.path} is no longer stored.`,
    };
  error.ambiguous = ambiguous;
  throw error;
}
async function send(write: SecretWrite, value: Redacted.Redacted<string>) {
  let ambiguous = false;
  for (let attempt = 0; ; attempt++) {
    try {
      return await sendOnce(write, value);
    } catch (failure) {
      const error =
        failure instanceof ApiError ? failure : new ApiError(503, true);
      if (unconfirmed(error)) {
        ambiguous = true;
        if (attempt < 2) continue;
      }
      return negativeReply(write, error, ambiguous);
    }
  }
}
function currentState(
  write: SecretWrite,
  secrets: readonly OwnerSecret[],
): WriteResult {
  const row = secrets.find((secret) => secret.path === write.secret.path);
  if (!row)
    return {
      secret: null,
      message: `${write.secret.path} is no longer stored.`,
    };
  if (write.op !== 'delete' && row.version === write.writeId)
    return { secret: row };
  if (write.op === 'create')
    return {
      secret: row,
      message: `${row.path} now exists. Review it before trying again.`,
    };
  if (row.version !== write.expectedVersion)
    return {
      secret: row,
      message: `${row.path} changed in another session. Review it and try again.`,
    };
  return {
    secret: row,
    message: `${row.path} is still stored with the version you last saw.`,
  };
}
function resolved(
  write: ObservedWrite,
  revision: number,
  secrets: readonly OwnerSecret[],
) {
  if (
    write.status !== 'error' ||
    !unconfirmed(write.error) ||
    revision <= write.revision
  )
    return write;
  return {
    ...write,
    status: 'success' as const,
    error: null,
    result: currentState(write.input, secrets),
  };
}
function projectWrite(write: ObservedWrite, revision: number) {
  if (write.status !== 'pending' && revision > write.revision) return false;
  return write.status !== 'error' || unconfirmed(write.error);
}
function optimisticSecret(write: ObservedWrite) {
  if (write.status === 'success') return write.result?.secret;
  return write.input.op === 'delete' ? null : write.input.secret;
}
function optimistic(
  secrets: readonly OwnerSecret[],
  writes: readonly ObservedWrite[],
  revision: number,
) {
  let visible = [...secrets];
  for (const write of writes) {
    if (!projectWrite(write, revision)) continue;
    const secret = optimisticSecret(write);
    visible = without(visible, write.input.secret.path);
    if (secret) visible.push(secret);
  }
  return visible;
}
function isWriting(queries: QueryClient) {
  return queries.isMutating({ mutationKey: writeKey }) > 0;
}
export function preloadVault(queries: QueryClient) {
  preloadBuckets(queries);
  if (!isWriting(queries)) void queries.prefetchQuery(secretsOptions);
}
export function useVault() {
  const queries = useQueryClient();
  // Values live only in this closure, which settlement clears. Mutation state is metadata only.
  const values = useRef(new Map<string, Redacted.Redacted<string>>());
  const raw = useMutationState<ObservedWrite>({
    filters: { mutationKey: writeKey },
    select: (mutation) => ({
      id: mutation.mutationId,
      input: mutation.state.variables as SecretWrite,
      status: mutation.state.status,
      error: mutation.state.error,
      result: mutation.state.data as WriteResult | undefined,
      revision:
        (mutation.state.context as { revision?: number } | undefined)
          ?.revision ?? 0,
    }),
  });
  const busy = raw.some((write) => write.status === 'pending');
  const query = useQuery({
    ...secretsOptions,
    staleTime: busy ? Infinity : secretsOptions.staleTime,
    refetchOnWindowFocus: busy ? false : secretsOptions.refetchOnWindowFocus,
  });
  const revision =
    queries.getQueryState(secretsOptions.queryKey)?.dataUpdateCount ?? 0;
  const writes = raw.map((write) =>
    resolved(write, revision, query.data ?? []),
  );
  const secrets = {
    ...query,
    data:
      query.data === undefined
        ? undefined
        : optimistic(query.data, raw, revision),
  };
  const write = useMutation({
    mutationKey: writeKey,
    // Unconfirmed submissions remain metadata-only until a list reconciles them.
    gcTime: Infinity,
    mutationFn: (input: SecretWrite) =>
      send(input, values.current.get(input.writeId) ?? Redacted.make('')),
    onMutate: async () => {
      await queries.cancelQueries({ queryKey: secretsOptions.queryKey });
      return {
        revision:
          queries.getQueryState(secretsOptions.queryKey)?.dataUpdateCount ?? 0,
      };
    },
    onSettled: (_result, error, input) => {
      values.current.delete(input.writeId);
      if (!unconfirmed(error))
        return queries.invalidateQueries({ queryKey: secretsOptions.queryKey });
    },
  });
  return {
    secrets,
    busy,
    write: writes.at(-1),
    saving: new Set(
      writes
        .filter((entry) => entry.status === 'pending')
        .map((entry) => entry.input.secret.path),
    ),
    confirming: new Set(
      writes
        .filter((entry) => entry.status === 'error' && unconfirmed(entry.error))
        .map((entry) => entry.input.secret.path),
    ),
    submit: (
      input: SecretWrite,
      value: string,
      onError: (error: Error) => void,
    ) => {
      if (isWriting(queries)) return false;
      values.current.set(input.writeId, Redacted.make(value));
      write.mutate(input, { onError });
      return true;
    },
  };
}
