import {
  type QueryClient,
  queryOptions,
  replaceEqualDeep,
} from '@tanstack/react-query';
import { runApi } from './api-client';

export const askFirstOptions = queryOptions({
  queryKey: ['ask-first'],
  queryFn: async ({ signal }) => [
    ...(await runApi((api) => api.askFirst.list(), signal)).marks,
  ],
  staleTime: 30_000,
  retry: false,
  gcTime: Infinity,
  structuralSharing: false,
  refetchOnWindowFocus: 'always',
});

// Eager query metadata lets Vault start marks alongside secrets. Controls and
// optimistic write projection stay in the lazy page.
export function preloadAskFirst(queries: QueryClient): void {
  void queries.prefetchQuery(askFirstOptions);
}

function existenceSource(key: readonly unknown[]) {
  return key[0] === 'buckets' || (key[0] === 'vault' && key[1] === 'secrets');
}
export function observeAskFirstExistence(queries: QueryClient) {
  const previous = new WeakMap<object, unknown>();
  return queries.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || !existenceSource(event.query.queryKey))
      return;
    const { query, action } = event;
    const before = previous.get(query);
    previous.set(query, query.state.data);
    // Initial parallel loads need no second marks read on navigation. Observe
    // any later data change, including cancellation restoring a prior snapshot.
    if (
      action.type !== 'invalidate' &&
      (before === undefined ||
        replaceEqualDeep(before, query.state.data) === before)
    )
      return;
    const filters = { queryKey: askFirstOptions.queryKey };
    // Even an inactive pre-write preload must not restore older existence.
    void queries
      .cancelQueries(filters)
      .then(() => queries.invalidateQueries(filters));
  });
}
