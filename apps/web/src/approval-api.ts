import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, runApi } from './api-client';
import { approvalScreen, type Choice, type Local } from './approval-screen';
import { approvalOptions, approvalsOptions } from './approvals-api';
import { useCountdown } from './use-countdown';

export function useApproval(id: string) {
  const queries = useQueryClient();
  const load = useQuery(approvalOptions(id));
  const [local, setLocal] = useState<Local>({});
  const [failure, setFailure] = useState<'network'>();
  const [decisionError, setDecisionError] = useState<Error>();
  const msLeft = useCountdown(
    load.data?.state === 'pending' ? load.data.expiresAt : undefined,
  );
  async function recover(error: unknown, choice: Choice) {
    if (
      error instanceof ApiError &&
      ['Expired', 'NotFound', 'AlreadyHandled'].includes(error.tag)
    )
      void queries.invalidateQueries({
        queryKey: approvalsOptions.queryKey,
        // The detail page has no sidebar observer. Refresh a previously loaded
        // list too, so its pending count is already correct before returning.
        refetchType: 'all',
      });
    if (error instanceof ApiError && error.tag === 'Expired') {
      setLocal({ unsaved: true, choice });
      return;
    }
    if (error instanceof ApiError && error.tag === 'NotFound') {
      setDecisionError(error);
      return;
    }
    if (error instanceof ApiError && error.tag === 'AlreadyHandled') {
      await load.refetch({ throwOnError: true });
      return;
    }
    setFailure('network');
  }
  async function decide(choice: Choice) {
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
      await queries.cancelQueries({
        queryKey: approvalOptions(id).queryKey,
        exact: true,
      });
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
