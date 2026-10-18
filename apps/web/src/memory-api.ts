import {
  type Memory,
  type MemoryScope,
  type MemoryVersion,
  RESERVED_BUCKET,
} from '@nook/contract';
import {
  type InferDataFromTag,
  infiniteQueryOptions,
  type Query,
  type QueryClient,
  queryOptions,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { runApi } from './api-client';
import { preloadBuckets } from './buckets-api';
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
  queryKey: memoryKeys.counts(),
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
    queryKey: memoryKeys.list(bucket, scope),
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
    queryKey: memoryKeys.detail(id),
    queryFn: async ({ signal, client }): Promise<Memory> => {
      const memory = await runApi(
        (api) => api.memories.get({ params: { id } }),
        signal,
      );
      return writeMemory(client, memory) ?? memory;
    },
    retry: false,
    staleTime: 30_000,
  });
}
export function memoryHistoryOptions(id: string, minimumVersion = 0) {
  return queryOptions({
    queryKey: memoryKeys.history(id),
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
      historyBehind(query.state.data, minimumVersion) ? 0 : 30_000,
  });
}
export function memorySearchOptions(
  bucket: string,
  scope: MemoryScope,
  q: string,
) {
  return queryOptions({
    queryKey: memoryKeys.search(bucket, scope, q.trim()),
    queryFn: ({ signal }) =>
      runApi(
        (api) => api.memories.search({ query: { bucket, scope, q: q.trim() } }),
        signal,
      ),
    enabled: Boolean(q.trim()),
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

type Cached<Options extends { queryKey: readonly unknown[] }> =
  InferDataFromTag<unknown, Options['queryKey']>;
type MemoryData = Cached<ReturnType<typeof memoryOptions>>;
type MemoriesData = Cached<ReturnType<typeof memoriesOptions>>;
type CountsData = Cached<typeof memoryCountsOptions>;
type SearchData = Cached<ReturnType<typeof memorySearchOptions>>;
type HistoryData = Cached<ReturnType<typeof memoryHistoryOptions>>;

export function writeMemory(
  queries: QueryClient,
  memory: Memory,
): Memory | undefined {
  return queries.setQueryData<MemoryData>(
    memoryKeys.detail(memory.id),
    (current) =>
      current && current.version > memory.version ? current : memory,
  );
}
const listKinds = new Set<string>([
  ...memoryKeys.lists(),
  ...memoryKeys.counts(),
  ...memoryKeys.searches(),
]);
const memoryKinds = new Set<string>([
  ...listKinds,
  ...memoryKeys.details(),
  ...memoryKeys.histories(),
]);
export const memoryQuery = (query: Query) =>
  memoryKinds.has(String(query.queryKey[0]));
export function invalidateMemoryLists(queries: QueryClient) {
  return queries.invalidateQueries({
    predicate: (query) => listKinds.has(String(query.queryKey[0])),
  });
}
export function forgetFromCache(
  queries: QueryClient,
  subject: { id: string; bucket: string },
) {
  const lists = { queryKey: memoryKeys.lists() };
  const counts = { queryKey: memoryKeys.counts() };
  const searches = { queryKey: memoryKeys.searches() };
  const detail = { queryKey: memoryKeys.detail(subject.id), exact: true };
  const history = { queryKey: memoryKeys.history(subject.id), exact: true };
  const snapshot = [
    ...queries.getQueriesData<MemoriesData>(lists),
    ...queries.getQueriesData<CountsData>(counts),
    ...queries.getQueriesData<SearchData>(searches),
    ...queries.getQueriesData<MemoryData>(detail),
    ...queries.getQueriesData<HistoryData>(history),
  ];
  queries.setQueriesData<MemoriesData>(
    lists,
    (data) =>
      data && {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          memories: page.memories.filter((memory) => memory.id !== subject.id),
        })),
      },
  );
  queries.setQueriesData<CountsData>(
    counts,
    (data) =>
      data && {
        counts: data.counts.map((row) =>
          row.bucket === subject.bucket
            ? { ...row, count: Math.max(0, row.count - 1) }
            : row,
        ),
      },
  );
  queries.setQueriesData<SearchData>(
    searches,
    (data) =>
      data && {
        ...data,
        results: data.results.filter((row) => row.id !== subject.id),
      },
  );
  queries.removeQueries(detail);
  queries.removeQueries(history);
  return snapshot;
}
export function restoreMemoryCache(
  queries: QueryClient,
  snapshot: ReturnType<typeof forgetFromCache>,
) {
  for (const [key, data] of snapshot) queries.setQueryData(key, data);
}
function historyBehind(
  versions: readonly MemoryVersion[] | undefined,
  minimumVersion: number,
) {
  return (versions?.[0]?.version ?? 0) < minimumVersion;
}
export function useMemoryHistory(detail: Memory) {
  const queries = useQueryClient();
  const history = useQuery(memoryHistoryOptions(detail.id, detail.version));
  const reconciled = useRef(0);
  const behind = historyBehind(history.data, detail.version);
  useEffect(() => {
    if (
      !history.data?.[0] ||
      !behind ||
      history.isFetching ||
      history.isError ||
      reconciled.current === detail.version
    )
      return;
    reconciled.current = detail.version;
    void history.refetch();
  }, [
    history.data,
    behind,
    detail.version,
    history.isFetching,
    history.isError,
    history.refetch,
  ]);
  const head = history.data?.[0];
  const memory =
    head && head.version > detail.version
      ? { ...detail, ...head, updatedAt: head.provenance.at }
      : detail;
  useEffect(() => {
    if (memory.version > detail.version) writeMemory(queries, memory);
  }, [queries, detail, memory]);
  return {
    memory,
    history: {
      ...history,
      isPending: history.isPending || (!history.isError && behind),
    },
  };
}
