import type { AuditFilters as ContractFilters } from '@nook/contract';
import { infiniteQueryOptions, type QueryClient } from '@tanstack/react-query';
import { runApi } from './api-client';
import { preloadMachines } from './machines-api';
import { preloadVault } from './vault-api';
export type AuditFilters = Pick<ContractFilters, 'bucket' | 'secret'>;
export function auditOptions(filters: AuditFilters) {
  return infiniteQueryOptions({
    queryKey: [
      'audit',
      { bucket: filters.bucket ?? '', secret: filters.secret ?? '' },
    ],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      runApi(
        (api) =>
          api.audit.list({
            query: {
              ...(filters.bucket ? { bucket: filters.bucket } : {}),
              ...(filters.secret ? { secret: filters.secret } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          }),
        signal,
      ),
    getNextPageParam: (page) => page.next,
    retry: false,
    staleTime: 0,
  });
}
export function preloadAudit(queries: QueryClient, filters: AuditFilters) {
  void queries.prefetchInfiniteQuery(auditOptions(filters));
  preloadVault(queries);
  preloadMachines(queries);
}
