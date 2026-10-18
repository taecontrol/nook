import {
  type QueryClient,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { ApiError, runApi, writeOutcome } from './api-client';
import {
  memoryHistoryOptions,
  memoryOptions,
  memoryWriteKey,
} from './memory-api';
import {
  forgetFromCache,
  invalidateMemoryLists,
  memoryQuery,
  restoreMemoryCache,
  writeMemory,
} from './memory-cache';

export type ForgetSubject = {
  id: string;
  bucket: string;
  title: string;
  version?: number;
};
export type ForgetRequest = ForgetSubject & { version: number };
export type ForgetWrite = ForgetRequest & { check?: true };
export type ForgetResult = 'forgotten' | 'failed' | 'changed';

export function latestForget(queries: QueryClient) {
  return queries
    .getMutationCache()
    .findAll({ mutationKey: memoryWriteKey })
    .at(-1);
}
export async function refreshChanged(queries: QueryClient, id: string) {
  queries.removeQueries({ queryKey: memoryOptions(id).queryKey, exact: true });
  queries.removeQueries({
    queryKey: memoryHistoryOptions(id).queryKey,
    exact: true,
  });
  const memory = await queries.fetchQuery({
    ...memoryOptions(id),
    staleTime: 0,
  });
  await queries.fetchQuery({
    ...memoryHistoryOptions(id, memory.version),
    staleTime: 0,
  });
}

export async function readForgetOutcome(id: string) {
  try {
    return await runApi((api) => api.memories.get({ params: { id } }));
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}
async function forgetRequest(subject: ForgetRequest): Promise<ForgetResult> {
  try {
    await runApi((api) =>
      api.memories.forget({
        params: { id: subject.id },
        query: { expectedVersion: String(subject.version) },
      }),
    );
  } catch (error) {
    if (error instanceof ApiError && error.tag === 'MemoryNotFound')
      return 'forgotten';
    if (writeOutcome(error) !== 'definitive') {
      const current = await readForgetOutcome(subject.id).catch(
        () => undefined,
      );
      if (current === null) return 'forgotten';
    }
    throw error;
  }
  return 'forgotten';
}
async function checkRequest(
  queries: QueryClient,
  subject: ForgetRequest,
): Promise<ForgetResult> {
  const token = latestForget(queries)?.mutationId;
  const current = await readForgetOutcome(subject.id);
  if (latestForget(queries)?.mutationId !== token) return 'forgotten';
  if (!current) return 'forgotten';
  writeMemory(queries, current);
  await invalidateMemoryLists(queries);
  return current.version === subject.version ? 'failed' : 'changed';
}
export function useForgetMemory() {
  const queries = useQueryClient();
  return useMutation({
    mutationKey: memoryWriteKey,
    gcTime: Infinity,
    mutationFn: (subject: ForgetWrite) =>
      subject.check ? checkRequest(queries, subject) : forgetRequest(subject),
    onMutate: async (subject) => {
      if (subject.check) return;
      await queries.cancelQueries({ predicate: memoryQuery });
      return forgetFromCache(queries, subject);
    },
    onError: async (error, subject, snapshot) => {
      if (subject.check || writeOutcome(error) !== 'definitive') return;
      if (snapshot) restoreMemoryCache(queries, snapshot);
      if (error instanceof ApiError && error.tag === 'MemoryChanged')
        await refreshChanged(queries, subject.id).catch(() => {});
    },
    onSettled: (_data, _error, _subject, snapshot) => {
      // Do not retain forgotten content in the settled mutation.
      if (snapshot) snapshot.length = 0;
      return queries.invalidateQueries({
        predicate: memoryQuery,
        refetchType: 'none',
      });
    },
  });
}
