import { bucketLineage, type CreatedBucket } from '@nook/contract';
import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { runApi as run } from './api-client';
import { sortBuckets } from './paths';
import { createWriteGate } from './write-gate';

const bucketsOptions = queryOptions({
  queryKey: ['buckets'],
  queryFn: async ({ signal }) => {
    const body = await run((api) => api.buckets.list(), signal);
    return [...body.buckets];
  },
  retry: false,
  staleTime: 30_000,
  refetchOnWindowFocus: 'always',
});

const writeKey = ['buckets', 'write'] as const;
const gate = createWriteGate(writeKey, { disableWhileBusy: true });
type BucketWrite = {
  id: number;
  operation: 'create' | 'delete';
  path: string;
  status: 'idle' | 'pending' | 'success' | 'error';
  error: Error | null;
  result?: CreatedBucket;
  added: string[];
};
async function refreshBuckets(queryClient: QueryClient) {
  const filters = { queryKey: bucketsOptions.queryKey };
  await queryClient.invalidateQueries({ ...filters, refetchType: 'none' });
  // Disabled observers still need one recovery read after the write result.
  if (queryClient.getQueryCache().find(filters)?.getObserversCount())
    await queryClient.prefetchQuery(bucketsOptions);
}

function useCreateBucket() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...writeKey, 'create'],
    mutationFn: async (path: string): Promise<CreatedBucket> => {
      return run((api) => api.buckets.create({ payload: { path } }));
    },
    onMutate: async (path) => {
      await queryClient.cancelQueries({ queryKey: bucketsOptions.queryKey });
      const current = queryClient.getQueryData(bucketsOptions.queryKey) ?? [];
      const existing = new Set(current.map((bucket) => bucket.path));
      const added = bucketLineage(path).filter(
        (prefix) => !existing.has(prefix),
      );
      const createdAt = new Date().toISOString();
      queryClient.setQueryData(bucketsOptions.queryKey, (buckets = []) =>
        sortBuckets([
          ...buckets,
          ...added.map((p) => ({ path: p, createdAt })),
        ]),
      );
      return { added };
    },
    onError: (_error, _path, context) => {
      const added = new Set(context?.added ?? []);
      queryClient.setQueryData(bucketsOptions.queryKey, (buckets = []) =>
        buckets.filter((bucket) => !added.has(bucket.path)),
      );
    },
    onSettled: () => refreshBuckets(queryClient),
  });
}

function useDeleteBucket() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...writeKey, 'delete'],
    mutationFn: async (path: string) => {
      await run((api) => api.buckets.delete({ params: { path } }));
    },
    onMutate: async (path) => {
      await queryClient.cancelQueries({ queryKey: bucketsOptions.queryKey });
      const current = queryClient.getQueryData(bucketsOptions.queryKey) ?? [];
      const removed = current.find((bucket) => bucket.path === path);
      queryClient.setQueryData(bucketsOptions.queryKey, (buckets = []) =>
        buckets.filter((bucket) => bucket.path !== path),
      );
      return { removed };
    },
    onError: (_error, _path, context) => {
      const removed = context?.removed;
      if (removed)
        queryClient.setQueryData(bucketsOptions.queryKey, (buckets = []) =>
          sortBuckets([
            ...buckets.filter((bucket) => bucket.path !== removed.path),
            removed,
          ]),
        );
    },
    onSettled: () => refreshBuckets(queryClient),
  });
}

export function preloadBuckets(queryClient: QueryClient) {
  gate.preload(queryClient, bucketsOptions);
}

export async function refreshBucketList(queryClient: QueryClient) {
  // Pending writes own the cached outline until their recovery read.
  if (gate.isWriting(queryClient))
    return queryClient.getQueryData(bucketsOptions.queryKey) ?? [];
  return queryClient.fetchQuery({ ...bucketsOptions, staleTime: 0 });
}

export function useBucketList() {
  return useQuery(gate.queryOptions(bucketsOptions, gate.useBusy()));
}

export function useBuckets() {
  const queryClient = useQueryClient();
  // The native mutation cache retains the operation across route unmounts.
  const { writes, busy, write } = gate.useWrites<BucketWrite>((mutation) => ({
    id: mutation.mutationId,
    operation: mutation.options.mutationKey?.[2] as BucketWrite['operation'],
    path: mutation.state.variables as string,
    status: mutation.state.status,
    error: mutation.state.error,
    result: mutation.state.data as CreatedBucket | undefined,
    added:
      (mutation.state.context as { added?: string[] } | undefined)?.added ?? [],
  }));
  const create = useCreateBucket();
  const remove = useDeleteBucket();
  const start = (operation: BucketWrite['operation'], path: string) => {
    return gate.start(queryClient, () =>
      (operation === 'create' ? create : remove).mutate(path),
    );
  };
  return {
    buckets: useBucketList(),
    create: (path: string) => start('create', path),
    remove: (path: string) => start('delete', path),
    busy,
    write,
    pending: new Set(
      writes
        .filter((write) => write.status === 'pending')
        .flatMap((write) => write.added),
    ),
  };
}
