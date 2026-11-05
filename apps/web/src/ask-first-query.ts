import { type QueryClient, queryOptions } from '@tanstack/react-query';
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

export async function refreshAskFirst(queries: QueryClient) {
  const filters = { queryKey: askFirstOptions.queryKey };
  // A pre-write preload can still be in flight without an active observer.
  await queries.cancelQueries(filters);
  await queries.invalidateQueries(filters);
}
