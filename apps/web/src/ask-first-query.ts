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
  const lastFetched = new WeakMap<object, unknown>();
  return queries.getQueryCache().subscribe((event) => {
    if (
      event.type !== 'updated' ||
      event.action.type !== 'success' ||
      event.action.manual ||
      !existenceSource(event.query.queryKey)
    )
      return;
    const { query } = event;
    const before = lastFetched.get(query);
    lastFetched.set(query, query.state.data);
    // Only changed server responses refresh existence. Optimistic writes and
    // invalidations say nothing about what exists yet. Initial parallel loads
    // and equal navigation/focus refetches need no second marks read.
    if (
      before === undefined ||
      replaceEqualDeep(before, query.state.data) === before
    )
      return;
    const filters = { queryKey: askFirstOptions.queryKey };
    // Even an inactive pre-write preload must not restore older existence.
    void queries
      .cancelQueries(filters)
      .then(() => queries.invalidateQueries(filters));
  });
}
