import type { Memory, MemoryScope } from '@nook/contract';
import {
  type InferDataFromTag,
  type Query,
  type QueryClient,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  memoriesOptions,
  memoryCountsOptions,
  type memoryHistoryOptions,
  memoryKeys,
  memoryOptions,
  memorySearchOptions,
  memoryWriteGate,
  memoryWriteKey,
  newer,
} from './memory-api';

export function writeMemory(
  queries: QueryClient,
  memory: Memory,
): Memory | undefined {
  return queries.setQueryData<Memory>(memoryKeys.detail(memory.id), (current) =>
    newer(current, memory),
  );
}

// Other memories remain readable while this id is being forgotten.
export function canLoadMemory(queries: QueryClient, id: string) {
  if (!id) return false;
  const writing = queries
    .getMutationCache()
    .findAll({ mutationKey: memoryWriteKey, status: 'pending' });
  return !writing.some((write) => {
    const subject = write.state.variables as { id: string; check?: boolean };
    return !subject.check && subject.id === id;
  });
}

type Cached<Options extends { queryKey: readonly unknown[] }> =
  InferDataFromTag<unknown, Options['queryKey']>;
type MemoryData = Cached<ReturnType<typeof memoryOptions>>;
type MemoriesData = Cached<ReturnType<typeof memoriesOptions>>;
type CountsData = Cached<typeof memoryCountsOptions>;
type SearchData = Cached<ReturnType<typeof memorySearchOptions>>;
type HistoryData = Cached<ReturnType<typeof memoryHistoryOptions>>;

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
  evictMemoryContent(queries, subject.id);
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
  return snapshot;
}
function evictMemoryContent(queries: QueryClient, id: string) {
  queries.setQueriesData<MemoriesData>(
    { queryKey: memoryKeys.lists() },
    (data) =>
      data && {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          memories: page.memories.filter((memory) => memory.id !== id),
        })),
      },
  );
  queries.setQueriesData<SearchData>(
    { queryKey: memoryKeys.searches() },
    (data) =>
      data && {
        ...data,
        results: data.results.filter((row) => row.id !== id),
      },
  );
  queries.removeQueries({ queryKey: memoryKeys.detail(id), exact: true });
  queries.removeQueries({ queryKey: memoryKeys.history(id), exact: true });
}
export async function reconcileForgottenMemory(
  queries: QueryClient,
  id: string,
) {
  // Cancel and evict together before a newer write can snapshot this content.
  const canceled = queries.cancelQueries({ predicate: memoryQuery });
  evictMemoryContent(queries, id);
  await canceled;
  // The optimistic removal may already have adjusted counts.
  return invalidateMemoryLists(queries);
}
export function restoreMemoryCache(
  queries: QueryClient,
  snapshot: ReturnType<typeof forgetFromCache>,
) {
  for (const [key, data] of snapshot) queries.setQueryData(key, data);
}
export function useMemoryQueries(
  bucket: string,
  scope: MemoryScope,
  q: string,
  id: string,
) {
  const queries = useQueryClient();
  const busy = memoryWriteGate.useBusy();
  const results = useQuery(
    memoryWriteGate.queryOptions(
      memorySearchOptions(bucket, scope, q),
      busy,
      queries,
    ),
  );
  const countsQuery = useQuery(
    memoryWriteGate.queryOptions(memoryCountsOptions, busy, queries),
  );
  const list = useInfiniteQuery(
    memoryWriteGate.queryOptions(memoriesOptions(bucket, scope), busy, queries),
  );
  const loadDetail = canLoadMemory(queries, id);
  const detail = useQuery(
    memoryWriteGate.queryOptions(
      memoryOptions(id),
      busy,
      queries,
      () => loadDetail && canLoadMemory(queries, id),
    ),
  );
  return { busy, results, countsQuery, list, detail };
}
