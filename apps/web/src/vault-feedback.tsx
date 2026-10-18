import { CircleAlert, CircleCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { ApiError, describeFailure, writeOutcome } from './api-client';
import { DismissibleAlert } from './failure';
import { type ObservedWrite, unconfirmed } from './vault-api';
import type { Feedback, WriteOp } from './vault-state';

const saving = {
  create: 'Saving secret…',
  replace: 'Replacing value…',
  delete: 'Deleting secret…',
};
const done = {
  create: 'Secret saved',
  replace: 'Value replaced',
  delete: 'Secret deleted',
};
const failed = {
  create: 'Couldn’t save secret',
  replace: 'Couldn’t replace value',
  delete: 'Couldn’t delete secret',
};
const past = {
  create: 'Stored',
  replace: 'Replaced the value of',
  delete: 'Deleted',
};
function uncertain(op: WriteOp, path: string) {
  const event = {
    create: `${path} was stored`,
    replace: `the value of ${path} was replaced`,
    delete: `${path} was deleted`,
  };
  return `Nook could not confirm whether ${event[op]}.`;
}
function failureMessage(write: ObservedWrite) {
  const { op, secret } = write.input;
  const error = write.error;
  const unchanged =
    op === 'create' ? 'Nothing was stored.' : 'Nothing changed.';
  if (!(error instanceof ApiError)) return uncertain(op, secret.path);
  if (error.tag === 'SecretChanged')
    return describeFailure(error, 'change secrets');
  if (error.tag === 'SecretExists')
    return writeOutcome(error) === 'ambiguous'
      ? `${secret.path} now exists. Review it before trying again.`
      : describeFailure(error, 'change secrets', unchanged);
  if (error.tag === 'SecretNotFound')
    return `${secret.path} is no longer stored.`;
  return describeFailure(error, 'change secrets', unchanged);
}
function successFeedback(write: ObservedWrite): Feedback {
  const { op, secret } = write.input;
  const message = write.result?.message;
  return {
    kind: message ? 'current' : 'done',
    op,
    path: secret.path,
    message: message ?? `${past[op]} ${secret.path}.`,
  };
}
export function feedbackFor(write: ObservedWrite | undefined): Feedback | null {
  if (!write || write.status === 'idle') return null;
  const { op, secret } = write.input;
  const path = secret.path;
  if (write.status === 'pending')
    return { kind: 'saving', op, path, message: path };
  if (write.status === 'success') return successFeedback(write);
  const unknown = unconfirmed(write.error);
  return {
    kind: unknown ? 'unconfirmed' : 'failed',
    op,
    path,
    message: unknown
      ? describeFailure(write.error, 'change secrets', uncertain(op, path))
      : failureMessage(write),
  };
}
function heading(feedback: Feedback) {
  if (feedback.kind === 'saving') return saving[feedback.op];
  if (feedback.kind === 'done') return done[feedback.op];
  if (feedback.kind === 'current') return 'Current secret state';
  if (feedback.kind === 'unconfirmed') return 'Write unconfirmed';
  return failed[feedback.op];
}
export function WriteFeedback({
  feedback,
  onDismiss,
  onRetry,
}: {
  feedback: Feedback;
  onDismiss: () => void;
  onRetry: () => void;
}) {
  const error = feedback.kind === 'failed' || feedback.kind === 'unconfirmed';
  return (
    <DismissibleAlert
      destructive={error}
      icon={
        feedback.kind === 'saving' ? (
          <Spinner />
        ) : error ? (
          <CircleAlert />
        ) : (
          <CircleCheck />
        )
      }
      title={heading(feedback)}
      onDismiss={feedback.kind === 'saving' ? undefined : onDismiss}
    >
      <p className="wrap-anywhere">{feedback.message}</p>
      {error && (
        <Button variant="outline" size="sm" className="mt-1" onClick={onRetry}>
          Try again
        </Button>
      )}
    </DismissibleAlert>
  );
}
