import type { MemoryListItem, OwnerMemorySearchResult } from '@nook/contract';
import {
  type Query,
  type QueryClient,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { ApiError, runApi } from './api-client';
import {
  memoryHistoryOptions,
  memoryOptions,
  memoryWriteKey,
} from './memory-api';

export type ForgetSubject = {
  id: string;
  bucket: string;
  title: string;
  version?: number;
};
export type ForgetRequest = ForgetSubject & { version: number };
type Pages = {
  pages: { memories: MemoryListItem[]; next: string | null }[];
  pageParams: unknown[];
};
type Results = {
  results: OwnerMemorySearchResult[];
  meaning: 'available' | 'unavailable';
};
const queryKinds = new Set([
  'memories',
  'memory-counts',
  'memory-search',
  'memory',
  'memory-history',
]);
const memoryQuery = (query: Query) => queryKinds.has(String(query.queryKey[0]));
function removedList(data: Pages, id: string): Pages {
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      memories: page.memories.filter((memory) => memory.id !== id),
    })),
  };
}
function removeCached(
  queries: QueryClient,
  query: Query,
  subject: ForgetRequest,
) {
  const key = query.queryKey;
  const data = query.state.data;
  if (data === undefined) return;
  switch (key[0]) {
    case 'memories':
      queries.setQueryData(key, removedList(data as Pages, subject.id));
      break;
    case 'memory-counts': {
      const counts = data as { counts: { bucket: string; count: number }[] };
      queries.setQueryData(key, {
        counts: counts.counts.map((row) =>
          row.bucket === subject.bucket
            ? { ...row, count: Math.max(0, row.count - 1) }
            : row,
        ),
      });
      break;
    }
    case 'memory-search': {
      const results = data as Results;
      queries.setQueryData(key, {
        ...results,
        results: results.results.filter((row) => row.id !== subject.id),
      });
      break;
    }
    default:
      if (key[1] === subject.id)
        queries.removeQueries({ queryKey: key, exact: true });
  }
}
async function refreshChanged(queries: QueryClient, id: string) {
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

export { refreshChanged };
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
      const snapshot = queries.getQueriesData({ predicate: memoryQuery });
      for (const query of queries
        .getQueryCache()
        .findAll({ predicate: memoryQuery }))
        removeCached(queries, query, subject);
      return snapshot;
    },
    onError: async (error, subject, snapshot) => {
      if (error instanceof ApiError && error.ambiguous) return;
      for (const [key, data] of snapshot ?? []) queries.setQueryData(key, data);
      if (error instanceof ApiError && error.tag === 'MemoryChanged')
        await refreshChanged(queries, subject.id).catch(() => {});
    },
    onSettled: (_data, _error, _subject, snapshot) => {
      if (snapshot) snapshot.length = 0;
      return queries.invalidateQueries({
        predicate: memoryQuery,
        refetchType: 'none',
      });
    },
  });
}
