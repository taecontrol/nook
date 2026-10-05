import { Api, type CreatedBucket } from '@nook/contract';
import {
  type QueryClient,
  queryOptions,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Effect } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { HttpApiClient } from 'effect/http-api';
import { lineage, sortBuckets } from './paths';

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`Request failed with ${status}`);
  }
}

const statusByTag: Record<string, number> = {
  Unauthorized: 401,
  Forbidden: 403,
  ServiceUnavailable: 503,
  InvalidBucketPath: 400,
  ReservedBucket: 400,
  BucketNotFound: 404,
  BucketHasChildren: 409,
};
const client = HttpApiClient.make(Api);
function run<A, E>(
  operation: (api: Effect.Success<typeof client>) => Effect.Effect<A, E>,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    Effect.flatMap(client, operation).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.mapError(
        (error) =>
          new ApiError(statusByTag[(error as { _tag: string })._tag] ?? 503),
      ),
    ),
    { signal },
  );
}

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
type BucketWrite = {
  id: number;
  operation: 'create' | 'delete';
  path: string;
  status: 'idle' | 'pending' | 'success' | 'error';
  error: Error | null;
  result?: CreatedBucket;
  added: string[];
};
function isWriting(queryClient: QueryClient) {
  return queryClient.isMutating({ mutationKey: writeKey }) > 0;
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
      const added = lineage(path).filter((prefix) => !existing.has(prefix));
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
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: bucketsOptions.queryKey }),
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
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: bucketsOptions.queryKey }),
  });
}

export function preloadBuckets(queryClient: QueryClient) {
  if (!isWriting(queryClient)) void queryClient.prefetchQuery(bucketsOptions);
}

export function useBuckets() {
  const queryClient = useQueryClient();
  // The native mutation cache retains the operation across route unmounts.
  const writes = useMutationState<BucketWrite>({
    filters: { mutationKey: writeKey },
    select: (mutation) => ({
      id: mutation.mutationId,
      operation: mutation.options.mutationKey?.[2] as BucketWrite['operation'],
      path: mutation.state.variables as string,
      status: mutation.state.status,
      error: mutation.state.error,
      result: mutation.state.data as CreatedBucket | undefined,
      added:
        (mutation.state.context as { added?: string[] } | undefined)?.added ??
        [],
    }),
  });
  const busy = writes.some((write) => write.status === 'pending');
  const create = useCreateBucket();
  const remove = useDeleteBucket();
  const start = (operation: BucketWrite['operation'], path: string) => {
    if (isWriting(queryClient)) return false;
    (operation === 'create' ? create : remove).mutate(path);
    return true;
  };
  return {
    buckets: useQuery({
      ...bucketsOptions,
      staleTime: busy ? Infinity : bucketsOptions.staleTime,
      refetchOnWindowFocus: busy ? false : bucketsOptions.refetchOnWindowFocus,
    }),
    create: (path: string) => start('create', path),
    remove: (path: string) => start('delete', path),
    busy,
    write: writes.at(-1),
    pending: new Set(
      writes
        .filter((write) => write.status === 'pending')
        .flatMap((write) => write.added),
    ),
  };
}
