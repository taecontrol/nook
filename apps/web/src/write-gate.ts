import {
  type FetchQueryOptions,
  type Mutation,
  type MutationKey,
  type MutationStatus,
  type Query,
  type QueryClient,
  type QueryKey,
  type QueryObserverOptions,
  useIsMutating,
  useMutationState,
} from '@tanstack/react-query';

export function observedWrites<Write extends { status: MutationStatus }>(
  writes: Write[],
) {
  return {
    writes,
    busy: writes.some((write) => write.status === 'pending'),
    write: writes.at(-1),
  };
}

export function createWriteGate(
  mutationKey: MutationKey,
  { disableWhileBusy }: { disableWhileBusy: boolean },
) {
  function isWriting(queries: QueryClient) {
    return queries.isMutating({ mutationKey }) > 0;
  }
  return {
    isWriting,
    preload<Data, Key extends QueryKey>(
      queries: QueryClient,
      options: FetchQueryOptions<Data, Error, Data, Key>,
    ) {
      if (!isWriting(queries)) void queries.prefetchQuery(options);
    },
    queryOptions<Data, QueryData, Key extends QueryKey, Options>(
      options: Options &
        Pick<
          QueryObserverOptions<Data, Error, Data, QueryData, Key>,
          'enabled' | 'staleTime' | 'refetchOnWindowFocus'
        >,
      busy: boolean,
      queries: QueryClient,
      canRead = () => !busy && !isWriting(queries),
    ) {
      return {
        ...options,
        // Query checks this before focus/remount reads, including the interval
        // before React renders a newly pending mutation.
        // Retain the previous disabled state after settlement so observers
        // resume queries first mounted during the write.
        ...(disableWhileBusy
          ? {
              enabled: (query: Query<Data, Error, QueryData, Key>) =>
                canRead() &&
                (typeof options.enabled === 'function'
                  ? options.enabled(query)
                  : options.enabled !== false),
            }
          : {}),
        staleTime: busy ? Infinity : options.staleTime,
        refetchOnWindowFocus: busy
          ? (false as const)
          : options.refetchOnWindowFocus,
      };
    },
    useBusy() {
      return useIsMutating({ mutationKey }) > 0;
    },
    useWrites<Write extends { status: MutationStatus }>(
      select: (mutation: Mutation) => Write,
    ) {
      return observedWrites(
        useMutationState<Write, Mutation>({
          filters: { mutationKey },
          select,
        }),
      );
    },
    start(queries: QueryClient, submit: () => void) {
      if (isWriting(queries)) return false;
      submit();
      return true;
    },
  };
}
