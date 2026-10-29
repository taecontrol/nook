import { CircleAlert, CircleCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { type ApiError, describeFailure } from './api-client';
import { DismissibleAlert } from './failure';
import { Path } from './path-text';
import { failureMessage, type ObservedWrite, unconfirmed } from './vault-api';
import { type ImportRun, retryable } from './vault-import';
import { plural } from './vault-model';
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
  if (!write || write.input.batch || write.status === 'idle') return null;
  const { op, secret } = write.input;
  const path = secret.path;
  if (write.status === 'pending')
    return { kind: 'saving', op, path, message: path };
  if (write.status === 'success') return successFeedback(write);
  const error = write.error;
  const unknown = unconfirmed(error);
  return {
    kind: unknown ? 'unconfirmed' : 'failed',
    op,
    path,
    message: unknown
      ? describeFailure(error, 'change secrets', uncertain(op, path))
      : failureMessage(write, error as ApiError),
  };
}

export function ImportNotice({
  run,
  onShow,
  onDismiss,
}: {
  run: ImportRun;
  onShow: () => void;
  onDismiss: () => void;
}) {
  const created = run.keys.filter((key) => key.outcome === 'created').length;
  const failed = run.keys.filter(retryable).length;
  if (!run.settled)
    return (
      <DismissibleAlert icon={<Spinner />} title="Importing secrets…">
        <p>
          {created} of {run.keys.length} created in <Path>{run.bucket}</Path>.
          New secret, Replace and Delete are paused until it finishes.
        </p>
        <Button variant="outline" size="sm" className="mt-1" onClick={onShow}>
          Show progress
        </Button>
      </DismissibleAlert>
    );
  if (failed)
    return (
      <DismissibleAlert
        destructive
        icon={<CircleAlert />}
        title="Import finished with problems"
        onDismiss={onDismiss}
      >
        <p>
          {created} created in <Path>{run.bucket}</Path>; {failed} need another
          try.
        </p>
        <Button variant="outline" size="sm" className="mt-1" onClick={onShow}>
          Show results
        </Button>
      </DismissibleAlert>
    );
  return (
    <DismissibleAlert
      icon={<CircleCheck />}
      title="Import finished"
      onDismiss={onDismiss}
    >
      <p>
        {plural(created, 'secret')} created in <Path>{run.bucket}</Path>.
      </p>
    </DismissibleAlert>
  );
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
