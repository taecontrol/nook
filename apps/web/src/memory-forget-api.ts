import {
  type QueryClient,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { ApiError, runApi } from './api-client';
import {
  forgetFromCache,
  memoryHistoryOptions,
  memoryOptions,
  memoryQuery,
  memoryWriteKey,
  restoreMemoryCache,
} from './memory-api';

export type ForgetSubject = {
  id: string;
  bucket: string;
  title: string;
  version?: number;
};
export type ForgetRequest = ForgetSubject & { version: number };
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
function unknownOutcome(error: unknown): error is ApiError {
  return error instanceof ApiError && error.outcomeUnknown;
}
async function forgetRequest(subject: ForgetRequest) {
  try {
    await runApi((api) =>
      api.memories.forget({
        params: { id: subject.id },
        query: { expectedVersion: String(subject.version) },
      }),
    );
  } catch (error) {
    if (error instanceof ApiError && error.tag === 'MemoryNotFound') return;
    if (unknownOutcome(error)) {
      try {
        if ((await readForgetOutcome(subject.id)) === null) return;
      } catch {
        error.ambiguous = true;
      }
    }
    throw error;
  }
}
export function useForgetMemory() {
  const queries = useQueryClient();
  return useMutation({
    mutationKey: memoryWriteKey,
    mutationFn: forgetRequest,
    onMutate: async (subject) => {
      await queries.cancelQueries({ predicate: memoryQuery });
      return forgetFromCache(queries, subject);
    },
    onError: async (error, subject, snapshot) => {
      if (error instanceof ApiError && error.ambiguous) return;
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
