import {
  type FetchQueryOptions,
  type Mutation,
  type MutationKey,
  type MutationStatus,
  type QueryClient,
  type QueryKey,
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
    queryOptions<
      Options extends {
        staleTime?: unknown;
        refetchOnWindowFocus?: unknown;
      },
    >(options: Options, busy: boolean) {
      return {
        ...options,
        ...(disableWhileBusy ? { enabled: !busy } : {}),
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
