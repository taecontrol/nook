import type { Memory, MemoryScope, MemoryVersion } from '@nook/contract';
import {
  infiniteQueryOptions,
  type QueryClient,
  queryOptions,
} from '@tanstack/react-query';
import { runApi } from './api-client';
import { preloadBuckets } from './buckets-api';
import { type MemorySearch, memoryLocation } from './memory-location';
import { createWriteGate } from './write-gate';

export const memoryKeys = {
  counts: () => ['memory-counts'] as const,
  lists: () => ['memories'] as const,
  list: (bucket: string, scope: MemoryScope) =>
    [...memoryKeys.lists(), bucket, scope] as const,
  details: () => ['memory'] as const,
  detail: (id: string) => [...memoryKeys.details(), id] as const,
  histories: () => ['memory-history'] as const,
  history: (id: string) => [...memoryKeys.histories(), id] as const,
  searches: () => ['memory-search'] as const,
  search: (bucket: string, scope: MemoryScope, q: string) =>
    [...memoryKeys.searches(), bucket, scope, q] as const,
};

export const memoryWriteKey = ['memory-write'] as const;
export const memoryWriteGate = createWriteGate(memoryWriteKey, {
  disableWhileBusy: true,
});
export const memoryCountsOptions = queryOptions({
  queryKey: memoryKeys.counts(),
  queryFn: ({ signal }) => runApi((api) => api.memories.counts(), signal),
  retry: false,
  staleTime: 30_000,
  refetchOnWindowFocus: 'always',
});
export function memoriesOptions(bucket: string, scope?: MemoryScope) {
  const location = memoryLocation({ bucket, scope });
  return infiniteQueryOptions({
    queryKey: memoryKeys.list(location.bucket, location.scope),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      runApi(
        (api) =>
          api.memories.list({
            query: {
              bucket: location.bucket,
              scope: location.scope,
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
    queryKey: memoryKeys.detail(id),
    queryFn: async ({ signal, client }): Promise<Memory> => {
      const memory = await runApi(
        (api) => api.memories.get({ params: { id } }),
        signal,
      );
      return newer(client.getQueryData<Memory>(memoryKeys.detail(id)), memory);
    },
    retry: false,
    staleTime: 30_000,
  });
}
export function memoryHistoryOptions(id: string, minimumVersion = 0) {
  return queryOptions({
    queryKey: memoryKeys.history(id),
    queryFn: async ({ signal }) => {
      const versions: MemoryVersion[] = [];
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
      historyBehind(query.state.data, minimumVersion) ? 0 : 30_000,
  });
}
export function memorySearchOptions(
  bucket: string,
  scope: MemoryScope,
  q: string,
) {
  q = memoryLocation({ q }).q;
  return queryOptions({
    queryKey: memoryKeys.search(bucket, scope, q),
    queryFn: ({ signal }) =>
      runApi(
        (api) => api.memories.search({ query: { bucket, scope, q } }),
        signal,
      ),
    enabled: Boolean(q),
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === bucket &&
      previousQuery?.queryKey[2] === scope
        ? previous
        : undefined,
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: 'always',
  });
}
export function preloadMemory(queries: QueryClient, search: MemorySearch) {
  const { bucket, scope, q } = memoryLocation(search);
  preloadBuckets(queries);
  memoryWriteGate.preload(queries, memoryCountsOptions);
  memoryWriteGate.start(
    queries,
    () => void queries.prefetchInfiniteQuery(memoriesOptions(bucket, scope)),
  );
  if (search.memory)
    memoryWriteGate.preload(queries, memoryOptions(search.memory));
  preloadHistory(queries, search);
  if (q)
    memoryWriteGate.preload(queries, memorySearchOptions(bucket, scope, q));
}

function preloadHistory(queries: QueryClient, search: MemorySearch) {
  if (search.memory && (search.history || search.version !== undefined))
    memoryWriteGate.preload(queries, memoryHistoryOptions(search.memory));
}

export function newer(current: Memory | undefined, next: Memory): Memory {
  return current && current.version > next.version ? current : next;
}
export function historyBehind(
  versions: readonly MemoryVersion[] | undefined,
  minimumVersion: number,
) {
  return (versions?.[0]?.version ?? 0) < minimumVersion;
}
