import { type MemoryScope, RESERVED_BUCKET } from '@nook/contract';
import {
  infiniteQueryOptions,
  type QueryClient,
  queryOptions,
} from '@tanstack/react-query';
import { runApi } from './api-client';
import { preloadBuckets } from './buckets-api';
import { createWriteGate } from './write-gate';

export const memoryWriteKey = ['memory-write'] as const;
export const memoryWriteGate = createWriteGate(memoryWriteKey, {
  disableWhileBusy: true,
});
export function canLoadMemory(queries: QueryClient, id: string) {
  if (!id) return false;
  const writing = queries
    .getMutationCache()
    .findAll({ mutationKey: memoryWriteKey, status: 'pending' });
  return !writing.some(
    (write) => (write.state.variables as { id: string }).id === id,
  );
}

export const memoryCountsOptions = queryOptions({
  queryKey: ['memory-counts'],
  queryFn: ({ signal }) => runApi((api) => api.memories.counts(), signal),
  retry: false,
  staleTime: 30_000,
  refetchOnWindowFocus: 'always',
});
export function memoriesOptions(
  bucket: string,
  scope: MemoryScope = 'inherited',
) {
  return infiniteQueryOptions({
    queryKey: ['memories', bucket, scope],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      runApi(
        (api) =>
          api.memories.list({
            query: {
              bucket,
              scope,
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          }),
        signal,
      ),
    getNextPageParam: (page) => page.next,
    retry: false,
    retryOnMount: false,
    staleTime: 30_000,
    refetchOnWindowFocus: 'always',
  });
}
export function memoryOptions(id: string) {
  return queryOptions({
    queryKey: ['memory', id],
    queryFn: ({ signal }) =>
      runApi((api) => api.memories.get({ params: { id } }), signal),
    retry: false,
    staleTime: 30_000,
  });
}
export function memoryHistoryOptions(id: string, minimumVersion = 0) {
  return queryOptions({
    queryKey: ['memory-history', id],
    queryFn: async ({ signal }) => {
      const versions: import('@nook/contract').MemoryVersion[] = [];
      let before: number | null = null;
      do {
        const page = await runApi(
          (api) =>
            api.memories.history({
              params: { id },
              query: before === null ? {} : { before: String(before) },
            }),
          signal,
        );
        versions.push(...page.versions);
        before = page.next;
      } while (before !== null);
      return versions;
    },
    retry: false,
    retryOnMount: false,
    staleTime: (query) =>
      (query.state.data?.[0]?.version ?? 0) < minimumVersion ? 0 : 30_000,
  });
}
export function memorySearchOptions(
  bucket: string,
  scope: MemoryScope,
  q: string,
) {
  return queryOptions({
    queryKey: ['memory-search', bucket, scope, q.trim()],
    queryFn: ({ signal }) =>
      runApi(
        (api) => api.memories.search({ query: { bucket, scope, q: q.trim() } }),
        signal,
      ),
    enabled: Boolean(q.trim()),
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: 'always',
  });
}
export type MemorySearch = {
  bucket?: string;
  memory?: string;
  scope?: MemoryScope;
  q?: string;
  history?: '1';
  version?: number;
  changes?: '1';
};
export function preloadMemory(queries: QueryClient, search: MemorySearch) {
  preloadBuckets(queries);
  if (memoryWriteGate.isWriting(queries)) return;
  void queries.prefetchQuery(memoryCountsOptions);
  void queries.prefetchInfiniteQuery(
    memoriesOptions(search.bucket ?? RESERVED_BUCKET, search.scope),
  );
  if (search.memory) void queries.prefetchQuery(memoryOptions(search.memory));
  preloadHistory(queries, search);
  if (search.q?.trim())
    void queries.prefetchQuery(
      memorySearchOptions(
        search.bucket ?? 'me',
        search.scope ?? 'inherited',
        search.q,
      ),
    );
}

function preloadHistory(queries: QueryClient, search: MemorySearch) {
  if (search.memory && (search.history || search.version !== undefined))
    void queries.prefetchQuery(memoryHistoryOptions(search.memory));
}
