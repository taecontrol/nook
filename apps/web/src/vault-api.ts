import type { OwnerSecret } from '@nook/contract';
import {
  type Mutation,
  type QueryClient,
  queryOptions,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Redacted } from 'effect';
import { ApiError, runApi, writeOutcome } from './api-client';
import { preloadBuckets } from './buckets-api';
import type { WriteOp } from './vault-state';
import { createWriteGate, observedWrites } from './write-gate';

const secretsOptions = queryOptions({
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
// Vault keeps its observer enabled so successful-list revisions can reconcile writes.
export const vaultGate = createWriteGate(writeKey, { disableWhileBusy: false });
export type SecretWrite = {
  op: WriteOp;
  secret: OwnerSecret;
  writeId: string;
  expectedVersion: string;
  batch?: string;
};
type WriteResult = { secret: OwnerSecret | null; message?: string };
export type ObservedWrite = {
  id: number;
  input: SecretWrite;
  status: 'idle' | 'pending' | 'success' | 'error';
  error: Error | null;
  result: WriteResult | undefined;
  revision: number;
  queued?: boolean;
};
function without(secrets: readonly OwnerSecret[], path: string) {
  return secrets.filter((secret) => secret.path !== path);
}
export function unconfirmed(error: Error | null) {
  return error !== null && writeOutcome(error) !== 'definitive';
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
  // A definitive retry cannot settle an earlier attempt that lost its answer.
  if (ambiguous)
    throw new ApiError(
      error.status,
      true,
      error.tag,
      error.hasPublicMessage ? error.message : undefined,
      error.current,
    );
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
export function preloadVault(queries: QueryClient) {
  preloadBuckets(queries);
  vaultGate.preload(queries, secretsOptions);
}
function observeWrite(mutation: Mutation): ObservedWrite {
  return {
    id: mutation.mutationId,
    input: mutation.state.variables as SecretWrite,
    status: mutation.state.status,
    error: mutation.state.error,
    result: mutation.state.data as WriteResult | undefined,
    revision:
      (mutation.state.context as { revision?: number } | undefined)?.revision ??
      0,
    queued: mutation.state.context === undefined,
  };
}
export function readVaultWrites(queries: QueryClient) {
  const revision =
    queries.getQueryState(secretsOptions.queryKey)?.dataUpdateCount ?? 0;
  const secrets =
    queries.getQueryData<OwnerSecret[]>(secretsOptions.queryKey) ?? [];
  return queries
    .getMutationCache()
    .findAll({ mutationKey: writeKey })
    .filter((mutation) => mutation.state.variables !== undefined)
    .map((mutation) => resolved(observeWrite(mutation), revision, secrets));
}
export function refreshVault(queries: QueryClient) {
  return queries.fetchQuery({ ...secretsOptions, staleTime: 0 });
}
export function executeWrite(
  queries: QueryClient,
  input: SecretWrite,
  value: Redacted.Redacted<string>,
  ready: () => Promise<void> = () => Promise.resolve(),
): Promise<void> {
  const mutation = queries
    .getMutationCache()
    .build<WriteResult, Error, SecretWrite, { revision: number }>(queries, {
      mutationKey: writeKey,
      gcTime: Infinity,
      mutationFn: (write: SecretWrite) => send(write, value),
      onMutate: async () => {
        // Queued writes hold the gate before waiting for a request slot.
        await ready();
        await queries.cancelQueries({ queryKey: secretsOptions.queryKey });
        return {
          revision:
            queries.getQueryState(secretsOptions.queryKey)?.dataUpdateCount ??
            0,
        };
      },
      onSettled: (_result, error) => {
        value = Redacted.make('');
        if (!input.batch && !unconfirmed(error))
          return queries.invalidateQueries({
            queryKey: secretsOptions.queryKey,
          });
      },
    });
  return mutation.execute(input).then(() => {});
}
function useSecretState() {
  const queries = useQueryClient();
  const { writes: raw, busy } = vaultGate.useWrites(observeWrite);
  const query = useQuery(vaultGate.queryOptions(secretsOptions, busy, queries));
  const revision =
    queries.getQueryState(secretsOptions.queryKey)?.dataUpdateCount ?? 0;
  const observed = observedWrites(
    raw.map((write) => resolved(write, revision, query.data ?? [])),
  );
  const secrets = {
    ...query,
    data:
      query.data === undefined
        ? undefined
        : optimistic(query.data, raw, revision),
  };
  return {
    ...observed,
    write: observed.writes.findLast((write) => !write.input.batch),
    secrets,
  };
}
export function useSecretList() {
  return useSecretState().secrets;
}
export function useVault() {
  const queries = useQueryClient();
  const { secrets, writes, busy, write: latest } = useSecretState();
  return {
    secrets,
    busy,
    write: latest,
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
    ) =>
      vaultGate.start(queries, () => {
        void executeWrite(queries, input, Redacted.make(value)).catch(onError);
      }),
  };
}
