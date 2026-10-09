import { Link } from '@tanstack/react-router';
import { Redacted } from 'effect';
import { Check, Copy, History, ServerCrash } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, runApi } from './api-client';
import { formatDate } from './paths';
import { type Secret, secretPath } from './vault-model';

type State =
  | { status: 'pending' }
  | { status: 'revealed'; value: Redacted.Redacted<string> }
  | { status: 'failed'; message: string };
function revealError(error: unknown) {
  return error instanceof ApiError &&
    ['SecretNotFound', 'VaultNotConfigured', 'SecretKeyUnavailable'].includes(
      error.tag,
    )
    ? error.message
    : "Couldn't reveal the value. Try again in a moment.";
}
function useReveal(path: string) {
  const [state, setState] = useState<State>({ status: 'pending' });
  const [request, setRequest] = useState({ path });
  useEffect(() => {
    const controller = new AbortController();
    void runApi(
      (api) => api.vault.reveal({ params: { path: request.path } }),
      controller.signal,
    ).then(
      ({ value }) => {
        if (!controller.signal.aborted) setState({ status: 'revealed', value });
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setState({ status: 'failed', message: revealError(error) });
      },
    );
    return () => controller.abort();
  }, [request]);
  return {
    state,
    retry: () => {
      setState({ status: 'pending' });
      setRequest({ path });
    },
  };
}
type CopyState = { status: 'idle' | 'copied' | 'failed' };
function useCopy() {
  const [state, setState] = useState<CopyState>({ status: 'idle' });
  useEffect(() => {
    if (state.status === 'idle') return;
    const timer = setTimeout(() => setState({ status: 'idle' }), 3000);
    return () => clearTimeout(timer);
  }, [state]);
  return {
    state: state.status,
    copy: (value: Redacted.Redacted<string>) => {
      void navigator.clipboard.writeText(Redacted.value(value)).then(
        () => setState({ status: 'copied' }),
        () => setState({ status: 'failed' }),
      );
    },
  };
}
function RevealBody({ state, onRetry }: { state: State; onRetry: () => void }) {
  if (state.status === 'pending')
    return (
      <div className="flex flex-col gap-2" role="status" aria-busy="true">
        <Skeleton className="h-28 w-full" />
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <Spinner className="size-3" />
          Revealing…
        </span>
      </div>
    );
  if (state.status === 'failed')
    return (
      <Alert variant="destructive">
        <ServerCrash />
        <AlertTitle>Couldn't reveal the value</AlertTitle>
        <AlertDescription>
          <p>{state.message}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={onRetry}
          >
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  const value = Redacted.value(state.value);
  return (
    <Textarea
      readOnly
      variant="secret"
      aria-label="Value"
      value={value}
      rows={value.includes('\n') ? 12 : 3}
      className="max-h-80 min-h-20 resize-none break-all whitespace-pre-wrap"
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      data-1p-ignore
      data-lpignore="true"
      data-bwignore
      data-form-type="other"
      onFocus={(event) => event.currentTarget.select()}
    />
  );
}
function CopyFeedback({ state }: { state: CopyState['status'] }) {
  return (
    <div aria-live="polite" className="min-h-5 text-sm">
      {state === 'copied' && (
        <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
          <Check className="size-4" />
          Copied to the clipboard.
        </span>
      )}
      {state === 'failed' && (
        <span className="text-destructive">
          Couldn't copy. Select the value and copy it yourself.
        </span>
      )}
    </div>
  );
}
export default function RevealDialog({
  secret,
  onClose,
}: {
  secret: Secret;
  onClose: () => void;
}) {
  const { state, retry } = useReveal(secretPath(secret));
  const clipboard = useCopy();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="wrap-anywhere">
            <span className="font-mono">{secret.name}</span>
          </DialogTitle>
          <DialogDescription className="wrap-anywhere">
            <span className="font-mono">{secretPath(secret)}</span> · Updated{' '}
            {formatDate(secret.updatedAt)}
          </DialogDescription>
        </DialogHeader>
        <RevealBody state={state} onRetry={retry} />
        {state.status === 'revealed' && (
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <History className="mt-0.5 size-3.5 shrink-0" />
            <span>
              This reveal is recorded in{' '}
              <Link
                to="/audit"
                search={{ secret: secretPath(secret) }}
                className="underline underline-offset-4"
              >
                Audit
              </Link>
              . The value is hidden again when you close this.
            </span>
          </p>
        )}
        <DialogFooter className="items-center sm:justify-between">
          <CopyFeedback state={clipboard.state} />
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
            <Button
              disabled={state.status !== 'revealed'}
              onClick={() =>
                state.status === 'revealed' && clipboard.copy(state.value)
              }
            >
              {clipboard.state === 'copied' ? <Check /> : <Copy />}
              {clipboard.state === 'copied' ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
