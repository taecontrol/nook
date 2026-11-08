import type { ApprovalList } from '@nook/contract';
import {
  type QueryClient,
  queryOptions,
  useQuery,
} from '@tanstack/react-query';
import { runApi } from './api-client';
import { approvalTimeLeft } from './approval-time';
import { useCountdown } from './use-countdown';

export const approvalsOptions = queryOptions({
  queryKey: ['approvals'],
  queryFn: ({ signal }) => runApi((api) => api.approvals.list(), signal),
  retry: false,
  staleTime: 30_000,
  refetchOnWindowFocus: 'always',
});
export const approvalOptions = (id: string) =>
  queryOptions({
    queryKey: ['approval', id],
    queryFn: ({ signal }) =>
      runApi((api) => api.approvals.get({ params: { id } }), signal),
    retry: false,
    staleTime: 30_000,
  });
export function preloadApprovals(queries: QueryClient): void {
  void queries.prefetchQuery({ ...approvalsOptions, staleTime: 0 });
}
export function preloadApproval(queries: QueryClient, id: string): void {
  void queries.prefetchQuery(approvalOptions(id));
}
export function usePendingCount(): number | undefined {
  const query = useApprovals();
  return query.isError || !query.data
    ? undefined
    : query.visible.pending.length;
}
export function useApprovals() {
  const query = useQuery(approvalsOptions);
  return { ...query, visible: useVisibleApprovals(query.data) };
}
function useVisibleApprovals(data: typeof ApprovalList.Type | undefined) {
  const now = Date.now();
  const { pending = [], remembered = [] } = data ?? {};
  const all = [...pending, ...remembered];
  const next = Math.min(
    ...all
      .map((view) => now + approvalTimeLeft(view, now))
      .filter((at) => at > now),
  );
  // Rows, section counts and the sidebar badge share browser-clock expiry.
  useCountdown(
    Number.isFinite(next) ? new Date(next).toISOString() : undefined,
  );
  return {
    pending: pending.filter((view) => approvalTimeLeft(view, now) > 0),
    remembered: remembered.filter((view) => approvalTimeLeft(view, now) > 0),
    now,
  };
}
