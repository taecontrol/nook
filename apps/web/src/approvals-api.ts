import type { ApprovalRemember as Remember } from '@nook/contract';
import {
  type QueryClient,
  queryOptions,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, runApi } from './api-client';
import { approvalScreen, type Choice } from './approval-screen';
import { useCountdown } from './use-countdown';

const approvalsOptions = queryOptions({
  queryKey: ['approvals'],
  queryFn: ({ signal }) => runApi((api) => api.approvals.list(), signal),
  retry: false,
  staleTime: 30_000,
  refetchOnWindowFocus: 'always',
});
const approvalOptions = (id: string) =>
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
  const query = useQuery({
    ...approvalsOptions,
    select: (data) => data.pending.length,
  });
  return query.isError ? undefined : query.data;
}
export function useApprovals() {
  return useQuery(approvalsOptions);
}
export function useApproval(id: string) {
  const queries = useQueryClient();
  const load = useQuery(approvalOptions(id));
  const [local, setLocal] = useState<{
    submitting?: Choice;
    unsaved?: boolean;
    choice?: Choice;
  }>({});
  const [failure, setFailure] = useState<'network'>();
  const [decisionError, setDecisionError] = useState<Error>();
  const msLeft = useCountdown(
    load.data?.state === 'pending' ? load.data.expiresAt : undefined,
  );
  async function recover(error: unknown, choice: Choice) {
    if (error instanceof ApiError && error.tag === 'Expired') {
      setLocal({ unsaved: true, choice });
      return;
    }
    if (error instanceof ApiError && error.tag === 'NotFound') {
      setDecisionError(error);
      return;
    }
    if (error instanceof ApiError && error.tag === 'AlreadyHandled') {
      await queries.fetchQuery({ ...approvalOptions(id), staleTime: 0 });
      return;
    }
    setFailure('network');
  }
  async function decide(choice: Remember | 'deny') {
    if (local.submitting) return;
    setFailure(undefined);
    setLocal({ submitting: choice });
    try {
      const view = await runApi((api) =>
        choice === 'deny'
          ? api.approvals.deny({ params: { id } })
          : api.approvals.approve({
              params: { id },
              payload: { remember: choice },
            }),
      );
      queries.setQueryData(approvalOptions(id).queryKey, view);
      void queries.invalidateQueries({ queryKey: approvalsOptions.queryKey });
    } catch (error) {
      try {
        await recover(error, choice);
      } catch {
        setFailure('network');
      }
    } finally {
      setLocal((current) => ({ ...current, submitting: undefined }));
    }
  }
  return {
    screen: load.data
      ? approvalScreen(load.data, Date.now(), local)
      : undefined,
    msLeft,
    failure,
    decide,
    load: {
      ...load,
      error: decisionError ?? load.error,
      isError: !!decisionError || load.isError,
      refetch: () => {
        setDecisionError(undefined);
        return load.refetch();
      },
    },
  };
}
