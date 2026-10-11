import { type MemoryScope, RESERVED_BUCKET } from '@nook/contract';
import {
  infiniteQueryOptions,
  type QueryClient,
  queryOptions,
} from '@tanstack/react-query';
import { runApi } from './api-client';
import { preloadBuckets } from './buckets-api';

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
export type MemorySearch = {
  bucket?: string;
  memory?: string;
  scope?: MemoryScope;
};
export function preloadMemory(queries: QueryClient, search: MemorySearch) {
  preloadBuckets(queries);
  void queries.prefetchQuery(memoryCountsOptions);
  void queries.prefetchInfiniteQuery(
    memoriesOptions(search.bucket ?? RESERVED_BUCKET, search.scope),
  );
  if (search.memory) void queries.prefetchQuery(memoryOptions(search.memory));
}
