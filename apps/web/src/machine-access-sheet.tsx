import type { BucketGrant, Machine } from '@nook/contract';
import { useQueryClient } from '@tanstack/react-query';
import { Check, CircleAlert, Minus, Plus, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { ApiError, describeFailure } from './api-client';
import { refreshBucketList, useBucketList } from './buckets-api';
import { LoadFailure } from './failure';
import { type GrantSelection, useGrantSelection } from './grant-selection';
import { GrantSelector } from './grant-selector';
import { GrantRoots } from './grant-summary';
import {
  type AccessChange,
  accessChanges,
  existingGrant,
  missingRoots,
} from './machine-access-model';
import { useSaveAccess } from './machines-api';
import { Path, PathList } from './path-text';

type Outcome =
  | { kind: 'none' | 'unconfirmed' | 'revoked' }
  | { kind: 'changed'; current: BucketGrant }
  | { kind: 'missing'; revision: number }
  | { kind: 'failed'; message: string };
function saveOutcome(error: Error, revision: number): Outcome {
  if (!(error instanceof ApiError) || error.outcomeUnknown)
    return { kind: 'unconfirmed' };
  if (error.current) return { kind: 'changed', current: error.current };
  if (error.tag === 'GrantBucketNotFound') return { kind: 'missing', revision };
  if (error.tag === 'NotFound') return { kind: 'revoked' };
  return {
    kind: 'failed',
    message: describeFailure(
      error,
      'edit machine access',
      'Nothing was saved. Try again.',
    ),
  };
}
const changeIcons = { add: Plus, remove: Minus, keep: Check };
const changeNames = { add: 'Adds', remove: 'Removes', keep: 'Keeps' };
function ChangeSummary({
  changes,
  empty,
}: {
  changes: AccessChange[];
  empty: boolean;
}) {
  const changed = changes.some((change) => change.kind !== 'keep');
  return (
    <div
      id="access-changes"
      aria-live="polite"
      className="flex flex-col gap-1.5"
    >
      <p className="text-xs font-medium text-muted-foreground">
        What saving changes
      </p>
      {empty ? (
        <p className="text-sm text-muted-foreground">
          Choose at least one bucket. To remove all access, revoke the machine.
        </p>
      ) : !changed ? (
        <p className="text-sm text-muted-foreground">No changes yet.</p>
      ) : (
        <ul className="flex max-h-28 flex-col gap-1 overflow-y-auto">
          {changes.map((change) => {
            const Icon = changeIcons[change.kind];
            return (
              <li
                key={`${change.kind}-${change.label}`}
                className="flex items-start gap-2 text-sm"
              >
                <Icon
                  aria-hidden
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                />
                <span className="sr-only">{changeNames[change.kind]} </span>
                <span className="min-w-0 flex-1">
                  {change.path ? (
                    <Path className="text-xs">{change.label}</Path>
                  ) : (
                    change.label
                  )}
                </span>
                <span className="shrink-0 text-xs leading-5 text-muted-foreground">
                  {change.effect}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
function outcomeCopy(outcome: Outcome, machine: Machine) {
  switch (outcome.kind) {
    case 'none':
      return null;
    case 'unconfirmed':
      return {
        title: "Couldn't confirm the change",
        body: (
          <p>
            Nook may or may not have saved it. Saving again is safe and sets the
            same access.
          </p>
        ),
      };
    case 'changed':
      return {
        title: 'Access changed elsewhere',
        body: (
          <>
            <p>
              Another tab or device saved first:{' '}
              <span className="wrap-anywhere">{machine.name}</span> now has{' '}
              <GrantRoots grant={outcome.current} />. Nothing was saved here.
            </p>
            <p>Review what saving changes now, then save again.</p>
          </>
        ),
      };
    case 'missing':
      return {
        title: 'Some selected buckets no longer exist. Choose again.',
        body: (
          <p>
            The bucket outline is refreshed without the deleted buckets. Your
            remaining choices are kept. Nothing was saved.
          </p>
        ),
      };
    case 'revoked':
      return {
        title: `${machine.name} was revoked`,
        body: (
          <>
            <p>
              Its token was deleted elsewhere, so there is no access left to
              change. It is gone from the list.
            </p>
            <p>
              To reconnect it, run <code className="font-mono">nook login</code>{' '}
              on it and approve it again.
            </p>
          </>
        ),
      };
    case 'failed':
      return { title: "Couldn't save access", body: <p>{outcome.message}</p> };
  }
}
function OutcomeAlert({
  outcome,
  machine,
}: {
  outcome: Outcome;
  machine: Machine;
}) {
  const alert = useRef<HTMLDivElement>(null);
  const copy = outcomeCopy(outcome, machine);
  useEffect(() => {
    if (outcome.kind !== 'none') alert.current?.focus({ preventScroll: true });
  }, [outcome]);
  return (
    copy && (
      <Alert ref={alert} tabIndex={-1} variant="destructive">
        <CircleAlert />
        <AlertTitle className="wrap-anywhere">{copy.title}</AlertTitle>
        <AlertDescription>{copy.body}</AlertDescription>
      </Alert>
    )
  );
}
function MissingRoots({ paths }: { paths: readonly string[] }) {
  if (!paths.length) return null;
  return (
    <Alert>
      <TriangleAlert />
      <AlertTitle>
        {paths.length === 1
          ? 'A bucket in its access no longer exists'
          : 'Some buckets in its access no longer exist'}
      </AlertTitle>
      <AlertDescription>
        <p>
          <PathList paths={paths} /> was deleted after this machine was
          approved. It gives no access now, and saving removes it.
        </p>
      </AlertDescription>
    </Alert>
  );
}
function AccessHeader({
  machine,
  baseline,
  revoked,
}: {
  machine: Machine;
  baseline: BucketGrant;
  revoked: boolean;
}) {
  return (
    <SheetHeader>
      <SheetTitle>Edit access</SheetTitle>
      <SheetDescription asChild>
        <div className="flex flex-col gap-1">
          <p className="font-medium text-foreground wrap-anywhere">
            {machine.name}
          </p>
          {!revoked && (
            <p className="wrap-anywhere">
              Now: <GrantRoots grant={baseline} />
            </p>
          )}
        </div>
      </SheetDescription>
    </SheetHeader>
  );
}
function blocked(
  selection: GrantSelection,
  changes: AccessChange[],
  outcome: Outcome,
) {
  const noChange = !changes.some((change) => change.kind !== 'keep');
  const empty = !selection.all && selection.roots.length === 0;
  const needsChoice =
    outcome.kind === 'missing' && outcome.revision === selection.revision;
  return noChange || empty || !selection.ready || needsChoice;
}
function SaveFooter({
  selection,
  changes,
  outcome,
  saving,
  disabled,
  onClose,
}: {
  selection: GrantSelection;
  changes: AccessChange[];
  outcome: Outcome;
  saving: boolean;
  disabled: boolean;
  onClose: () => void;
}) {
  const revoked = outcome.kind === 'revoked';
  const label = outcome.kind === 'unconfirmed' ? 'Try again' : 'Save access';
  return (
    <SheetFooter>
      {!revoked && (
        <ChangeSummary
          changes={changes}
          empty={!selection.all && selection.roots.length === 0}
        />
      )}
      <div className="flex flex-row justify-end gap-2 pt-2">
        {revoked ? (
          <Button type="button" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving || disabled}
              aria-describedby="access-changes"
            >
              {saving && <Spinner />}
              {saving ? 'Saving…' : label}
            </Button>
          </>
        )}
      </div>
    </SheetFooter>
  );
}
type EditorProps = {
  machine: Machine;
  onClose: () => void;
  onSaved: (machine: Machine) => void;
  onRevoked: (machine: Machine) => void;
  onSavingChange: (saving: boolean) => void;
  existing: Set<string>;
};
function AccessEditor({
  machine,
  onClose,
  onSaved,
  onRevoked,
  onSavingChange,
  existing,
}: EditorProps) {
  const [baseline, setBaseline] = useState(machine.grant);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'none' });
  const selection = useGrantSelection(existingGrant(machine.grant, existing));
  const save = useSaveAccess();
  const body = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const missing = missingRoots(baseline, existing);
  const changes = accessChanges(baseline, selection.grant, missing);
  const disabled = blocked(selection, changes, outcome);
  const revoked = outcome.kind === 'revoked';
  const report = (error: Error) => {
    const next = saveOutcome(error, selection.revision);
    if (next.kind === 'changed') setBaseline(next.current);
    if (next.kind === 'missing') void selection.retry();
    if (next.kind === 'revoked') onRevoked(machine);
    setOutcome(next);
    body.current?.scrollTo({ top: 0 });
  };
  const submit = () => {
    if (save.busy || revoked || disabled || !selection.validate()) return;
    const started = save.start(
      { machine: { ...machine, grant: baseline }, grant: selection.grant },
      {
        onSuccess: onSaved,
        onError: report,
        onSettled: () => onSavingChange(false),
      },
    );
    if (started) {
      setOutcome({ kind: 'none' });
      onSavingChange(true);
      form.current?.focus({ preventScroll: true });
    }
  };
  return (
    <form
      ref={form}
      tabIndex={-1}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      aria-busy={save.isPending}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <AccessHeader machine={machine} baseline={baseline} revoked={revoked} />
      <Separator />
      <div
        ref={body}
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4"
      >
        <OutcomeAlert outcome={outcome} machine={machine} />
        {!revoked && (
          <>
            <MissingRoots paths={missing} />
            <GrantSelector
              selection={selection}
              busy={save.busy}
              contained={false}
              editing
            />
          </>
        )}
      </div>
      <Separator />
      <SaveFooter
        selection={selection}
        changes={changes}
        outcome={outcome}
        saving={save.isPending}
        disabled={disabled}
        onClose={onClose}
      />
    </form>
  );
}
function EditorLoading({
  machine,
  onClose,
}: {
  machine: Machine;
  onClose: () => void;
}) {
  const buckets = useBucketList();
  const queries = useQueryClient();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AccessHeader
        machine={machine}
        baseline={machine.grant}
        revoked={false}
      />
      <Separator />
      <div className="flex flex-1 flex-col gap-4 p-4">
        {buckets.isError ? (
          <LoadFailure
            title="Couldn't load buckets"
            description="Check your connection and try again."
            cached={false}
            retrying={buckets.isFetching}
            onRetry={() => void refreshBucketList(queries).catch(() => {})}
          />
        ) : (
          <div
            role="status"
            aria-label="Loading buckets"
            className="flex flex-col gap-4"
          >
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-32" />
            <p className="text-sm text-muted-foreground">
              Loading the bucket outline…
            </p>
          </div>
        )}
      </div>
      <Separator />
      <SheetFooter>
        <div className="flex flex-row justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled>Save access</Button>
        </div>
      </SheetFooter>
    </div>
  );
}
export function AccessSheet({
  machine,
  open,
  session,
  onClose,
  onCloseAutoFocus,
  onSaved,
  onRevoked,
}: {
  machine: Machine;
  open: boolean;
  session: number;
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
  onSaved: (machine: Machine) => void;
  onRevoked: (machine: Machine) => void;
}) {
  const buckets = useBucketList();
  const [saving, setSaving] = useState(false);
  const existing = new Set((buckets.data ?? []).map((bucket) => bucket.path));
  return (
    <Sheet open={open} onOpenChange={(next) => !next && !saving && onClose()}>
      <SheetContent
        className="w-full sm:max-w-lg"
        motion="instant"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {buckets.data ? (
          <AccessEditor
            key={`${machine.id}-${session}`}
            machine={machine}
            existing={existing}
            onClose={onClose}
            onSaved={onSaved}
            onRevoked={onRevoked}
            onSavingChange={setSaving}
          />
        ) : (
          <EditorLoading machine={machine} onClose={onClose} />
        )}
      </SheetContent>
    </Sheet>
  );
}
