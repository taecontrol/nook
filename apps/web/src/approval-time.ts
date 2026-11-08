import type { ApprovalView } from '@nook/contract';

export function approvalTimeLeft(view: ApprovalView, now: number) {
  return (
    Date.parse(view.state === 'approved' ? view.validUntil : view.expiresAt) -
    now
  );
}
