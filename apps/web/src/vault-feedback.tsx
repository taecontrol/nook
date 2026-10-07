import { CircleAlert, CircleCheck, X } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { ApiError } from './api-client';
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
  if (error.tag === 'SecretChanged') return error.message;
  if (error.tag === 'SecretExists')
    return error.ambiguous
      ? `${secret.path} now exists. Review it before trying again.`
      : `${error.message} ${unchanged}`;
  if (error.tag === 'SecretNotFound')
    return `${secret.path} is no longer stored.`;
  return `${definitiveMessage(error)} ${unchanged}`;
}
function definitiveMessage(error: ApiError) {
  if (error.status === 401)
    return 'Your owner session expired. Sign in again, then try again.';
  if (error.status === 403)
    return 'Only this installation’s owner can change secrets.';
  return error.message;
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
    message: unknown ? uncertain(op, path) : failureMessage(write),
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
    <Alert variant={error ? 'destructive' : 'default'}>
      {feedback.kind === 'saving' ? (
        <Spinner />
      ) : error ? (
        <CircleAlert />
      ) : (
        <CircleCheck />
      )}
      <AlertTitle className="mr-6">{heading(feedback)}</AlertTitle>
      <AlertDescription>
        <p className="wrap-anywhere">{feedback.message}</p>
        {error && (
          <Button
            variant="outline"
            size="sm"
            className="mt-1"
            onClick={onRetry}
          >
            Try again
          </Button>
        )}
      </AlertDescription>
      {feedback.kind !== 'saving' && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="absolute top-2.5 right-2.5"
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          <X />
        </Button>
      )}
    </Alert>
  );
}
