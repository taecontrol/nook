import type { Machine } from '@nook/contract';
import { useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  CalendarX,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Hourglass,
  MonitorSmartphone,
} from 'lucide-react';
import { type ComponentProps, Fragment, useRef, useState } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { describeFailure, writeOutcome } from './api-client';
import { preloadBuckets } from './buckets-api';
import { DismissibleAlert, LoadFailure } from './failure';
import { MachineAccess } from './grant-summary';
import { type MachineRevoke, useMachines } from './machines-api';
import {
  activityParts,
  approvalParts,
  approvedText,
  groupMachines,
  isExpired,
  lastUsedParts,
} from './machines-model';
import { formatDate } from './time';
import { useConfirmTarget } from './use-confirm-target';
import { useMachineClock } from './use-machine-clock';

const icons = {
  expired: CalendarX,
  stale: Hourglass,
  never: CircleDashed,
  recent: Activity,
};
const loadAccessSheet = () => import('./machine-access-sheet');
type AccessSheetComponent = typeof import('./machine-access-sheet').AccessSheet;
type EditorModule = { Sheet: AccessSheetComponent } | { error: unknown };
function MachineEditor({
  loaded,
  machine,
  ...props
}: {
  loaded: EditorModule | undefined;
  machine: Machine | null;
} & Omit<ComponentProps<AccessSheetComponent>, 'machine'>) {
  if (!loaded) return null;
  if ('error' in loaded) throw loaded.error;
  return machine ? <loaded.Sheet machine={machine} {...props} /> : null;
}
function Facts({ parts }: { parts: string[] }) {
  return parts.map((part, index) => (
    <Fragment key={part}>
      {index > 0 && ' '}
      <span className="whitespace-nowrap">
        {part}
        {index < parts.length - 1 && ' ·'}
      </span>
    </Fragment>
  ));
}
function LoginCommand() {
  return (
    <code className="inline-block max-w-full rounded-md bg-muted px-2 py-1 font-mono text-sm text-foreground wrap-anywhere">
      nook login {window.location.origin}
    </code>
  );
}
function MachinesSkeleton() {
  return (
    <div role="status" aria-label="Loading machines" aria-busy="true">
      <div className="mb-3 border-b pb-2">
        <div className="flex h-8 items-center">
          <Skeleton className="h-3 w-36" />
        </div>
        <Skeleton className="mt-1 h-4 w-64 max-w-full" />
      </div>
      <div className="flex flex-col gap-2">
        {[
          { id: 'first', title: <Skeleton className="h-4 w-32" /> },
          { id: 'second', title: <Skeleton className="h-4 w-40" /> },
          { id: 'third', title: <Skeleton className="h-4 w-28" /> },
        ].map(({ id, title }) => (
          <Item key={id} variant="outline">
            <Skeleton className="hidden size-8 sm:block" />
            <ItemContent className="min-w-0">
              <div className="flex flex-col gap-2">
                {title}
                <Skeleton className="h-3.5 w-48 max-w-full" />
                <Skeleton className="h-3.5 w-56 max-w-full" />
              </div>
            </ItemContent>
            <Skeleton className="h-8 w-18" />
          </Item>
        ))}
      </div>
    </div>
  );
}
function NoMachines() {
  return (
    <div className="rounded-lg border border-dashed">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MonitorSmartphone />
          </EmptyMedia>
          <EmptyTitle>No machines connected</EmptyTitle>
          <EmptyDescription>
            To connect a machine, run this on it and approve the request that
            opens here.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <LoginCommand />
        </EmptyContent>
      </Empty>
    </div>
  );
}
function MachineActions({
  machine,
  now,
  busy,
  preload,
  onEdit,
  onRevoke,
}: {
  machine: Machine;
  now: number;
  busy: boolean;
  preload: () => void;
  onEdit: (machine: Machine, trigger: HTMLButtonElement) => void;
  onRevoke: (machine: Machine, trigger: HTMLButtonElement) => void;
}) {
  const expired = isExpired(machine, now);
  const action = expired ? 'Remove' : 'Revoke';
  return (
    <ItemActions className="flex-col items-stretch self-start sm:flex-row sm:self-center">
      {!expired && (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          aria-label={`Edit access of ${machine.name}`}
          onPointerEnter={preload}
          onFocus={preload}
          onClick={(event) => onEdit(machine, event.currentTarget)}
        >
          Edit access
        </Button>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        aria-label={`${action} ${machine.name}, ${approvedText(machine, now).toLowerCase()}`}
        onClick={(event) => onRevoke(machine, event.currentTarget)}
      >
        {action}
      </Button>
    </ItemActions>
  );
}
function MachineGroups({
  machines,
  now,
  busy,
  onRevoke,
  onEdit,
  saved,
}: {
  machines: readonly Machine[];
  now: number;
  busy: boolean;
  onRevoke: (machine: Machine, trigger: HTMLButtonElement) => void;
  onEdit: (machine: Machine, trigger: HTMLButtonElement) => void;
  saved?: string;
}) {
  const queries = useQueryClient();
  const preload = () => {
    preloadBuckets(queries);
    void loadAccessSheet().catch(() => {});
  };
  return (
    <div className="flex flex-col gap-10">
      {groupMachines(machines, now).map((group) => {
        const Icon = icons[group.id];
        return (
          <section key={group.id} aria-labelledby={`machines-${group.id}`}>
            <div className="mb-3 border-b pb-2">
              <div className="flex h-8 items-center gap-2">
                <h2
                  id={`machines-${group.id}`}
                  className="text-xs font-medium tracking-wider text-muted-foreground uppercase"
                >
                  {group.title}
                </h2>
                <Badge variant="secondary">{group.machines.length}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">{group.hint}</p>
            </div>
            <ul className="flex flex-col gap-2">
              {group.machines.map((machine) => (
                <li key={machine.id}>
                  <Item variant="outline" data-machine={machine.id}>
                    <ItemMedia variant="icon" className="hidden sm:flex">
                      <Icon />
                    </ItemMedia>
                    <ItemContent className="min-w-0">
                      <ItemTitle className="w-full flex-wrap wrap-anywhere">
                        {machine.name}
                        {saved === machine.id && (
                          <Badge variant="secondary">
                            <CircleCheck />
                            Access saved
                          </Badge>
                        )}
                      </ItemTitle>
                      <ItemDescription>
                        <Facts parts={activityParts(machine, now)} />
                      </ItemDescription>
                      <ItemDescription truncate={false}>
                        <Facts parts={approvalParts(machine, now)} /> ·{' '}
                        <MachineAccess grant={machine.grant} />
                      </ItemDescription>
                    </ItemContent>
                    <MachineActions
                      machine={machine}
                      now={now}
                      busy={busy}
                      preload={preload}
                      onEdit={onEdit}
                      onRevoke={onRevoke}
                    />
                  </Item>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
function revokeHeading(write: MachineRevoke) {
  const removal = isExpired(write.machine, write.submittedAt);
  if (write.status === 'success') return removal ? 'Removed ' : 'Revoked ';
  if (writeOutcome(write.error) !== 'definitive')
    return removal
      ? "Couldn't confirm removal of "
      : "Couldn't confirm revocation of ";
  return removal ? "Couldn't remove " : "Couldn't revoke ";
}
function revokeProblem(error: Error | null) {
  return describeFailure(
    error,
    'manage machines',
    writeOutcome(error) !== 'definitive'
      ? 'The machine may already be revoked. Try again to confirm it is revoked.'
      : 'Check the machine list before trying again.',
  );
}
function RevokeFeedback({
  write,
  onDismiss,
  onRetry,
}: {
  write: MachineRevoke;
  onDismiss: () => void;
  onRetry: (machine: Machine, trigger: HTMLButtonElement) => void;
}) {
  const { machine } = write;
  const removal = isExpired(machine, write.submittedAt);
  if (write.status === 'pending')
    return (
      <Alert>
        <Spinner />
        <AlertTitle>
          {removal ? 'Removing' : 'Revoking'}{' '}
          <span className="wrap-anywhere">{machine.name}</span>…
        </AlertTitle>
      </Alert>
    );
  const failed = write.status === 'error';
  return (
    <DismissibleAlert
      destructive={failed}
      icon={failed ? <CircleAlert /> : <CircleCheck />}
      title={
        <>
          {revokeHeading(write)}
          {machine.name}
        </>
      }
      onDismiss={onDismiss}
    >
      {failed ? (
        <>
          <p>{revokeProblem(write.error)}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-1"
            onClick={(event) => onRetry(machine, event.currentTarget)}
          >
            Try again
          </Button>
        </>
      ) : removal ? (
        <>
          <p>
            Its expired token is deleted. To reconnect that machine, run this on
            it and approve it again:
          </p>
          <div className="mt-1">
            <LoginCommand />
          </div>
        </>
      ) : (
        <>
          <p>
            The token approved {formatDate(machine.approvedAt)} is deleted. That
            machine's next request to Nook will fail. To reconnect it, run this
            on it and approve it again:
          </p>
          <div className="mt-1">
            <LoginCommand />
          </div>
        </>
      )}
    </DismissibleAlert>
  );
}
function RevokeConfirmation({
  machine,
  now,
  onCancel,
  onConfirm,
  onClose,
}: {
  machine: Machine;
  now: number;
  onCancel: () => void;
  onConfirm: () => void;
  onClose: (event: Event) => void;
}) {
  return (
    <AlertDialog open onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent onCloseAutoFocus={onClose}>
        <AlertDialogHeader>
          <AlertDialogTitle className="wrap-anywhere">
            Revoke {machine.name}?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-3">
              <p>
                <Facts
                  parts={[
                    approvedText(machine, now),
                    ...lastUsedParts(machine, now),
                  ]}
                />
              </p>
              <p>
                Its token is deleted immediately and this can't be undone. The
                machine's next request to Nook will fail. To reconnect it later,
                run this on it and approve it again:
              </p>
              <div>
                <LoginCommand />
              </div>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Revoke machine
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
function MachineList({
  state,
  now,
  onRevoke,
  onEdit,
  saved,
}: {
  state: ReturnType<typeof useMachines>;
  now: number;
  onRevoke: (machine: Machine, trigger: HTMLButtonElement) => void;
  onEdit: (machine: Machine, trigger: HTMLButtonElement) => void;
  saved?: string;
}) {
  const { machines, busy } = state;
  if (machines.isPending) return <MachinesSkeleton />;
  const cached = machines.data !== undefined;
  const problem = describeFailure(machines.error, 'manage machines');
  const failure = (
    <LoadFailure
      title={cached ? "Couldn't refresh machines" : "Couldn't load machines"}
      description={
        cached ? `Showing the last loaded machines. ${problem}` : problem
      }
      cached={cached}
      retrying={machines.isFetching}
      onRetry={() => machines.refetch()}
      className={cached ? 'mb-6' : undefined}
    />
  );
  if (machines.data === undefined) return failure;
  return (
    <>
      {machines.isError && failure}
      {machines.data.length === 0 ? (
        <NoMachines />
      ) : (
        <MachineGroups
          machines={machines.data}
          now={now}
          busy={busy}
          onRevoke={onRevoke}
          onEdit={onEdit}
          saved={saved}
        />
      )}
    </>
  );
}
type SavedAccess = { machine: Machine; id: number };
function SavedAnnouncement({ saved }: { saved: SavedAccess | null }) {
  return (
    <div aria-live="polite" className="sr-only">
      {saved && (
        <p key={saved.id}>
          Saved access for {saved.machine.name}. It applies on the machine's
          next request to Nook.
        </p>
      )}
    </div>
  );
}
function RevokedElsewhere({
  machine,
  onDismiss,
}: {
  machine: Machine | null;
  onDismiss: () => void;
}) {
  if (!machine) return null;
  return (
    <DismissibleAlert
      icon={<CircleAlert />}
      title={<>{machine.name} was revoked elsewhere</>}
      onDismiss={onDismiss}
    >
      <p>
        The machine is no longer approved. To reconnect it, run this on it and
        approve it again:
      </p>
      <div className="mt-1">
        <LoginCommand />
      </div>
    </DismissibleAlert>
  );
}
export function MachinesPage() {
  const state = useMachines();
  const { machines, write, busy, revoke } = state;
  const [dismissed, setDismissed] = useState<number>();
  const heading = useRef<HTMLHeadingElement | null>(null);
  const revocation = useConfirmTarget<Machine>(() => heading.current);
  const editing = useConfirmTarget<Machine>(() => heading.current);
  const [session, setSession] = useState(0);
  const [saved, setSaved] = useState<SavedAccess | null>(null);
  const [gone, setGone] = useState<Machine | null>(null);
  const [editor, setEditor] = useState<EditorModule>();
  const now = useMachineClock(machines.data);
  const list = machines.data;
  const confirm = (machine: Machine, button: HTMLButtonElement) => {
    if (busy) return;
    if (isExpired(machine, Date.now())) {
      revoke(machine);
      heading.current?.focus({ preventScroll: true });
    } else revocation.open(machine, button);
  };
  return (
    <div className="w-full max-w-4xl px-4 pb-24 sm:px-6 md:px-12">
      <h1
        ref={heading}
        tabIndex={-1}
        className="pt-6 pb-2 text-xl font-semibold tracking-tight md:pt-8"
      >
        Machines
      </h1>
      {list && list.length > 0 ? (
        <p className="mb-6 max-w-2xl text-sm text-muted-foreground">
          Every machine that holds a Nook token, grouped by last use. Expired
          machines and the ones you may no longer use come first.
        </p>
      ) : (
        <div className="h-4" />
      )}
      <SavedAnnouncement saved={saved} />
      <div aria-live="polite" className="empty:hidden mb-6 flex flex-col gap-2">
        <RevokedElsewhere machine={gone} onDismiss={() => setGone(null)} />
        {write && write.id !== dismissed && (
          <RevokeFeedback
            write={write}
            onDismiss={() => setDismissed(write.id)}
            onRetry={confirm}
          />
        )}
      </div>
      <MachineList
        state={state}
        now={now}
        onRevoke={confirm}
        saved={saved?.machine.id}
        onEdit={(machine, button) => {
          if (busy) return;
          // A resolved module mounts directly. Suspending a fresh lazy wrapper
          // would delay the checked tree even after its intent preload finished.
          void loadAccessSheet().then(
            (module) => {
              setEditor({ Sheet: module.AccessSheet });
              setSession((value) => value + 1);
              setSaved(null);
              setGone(null);
              editing.open(machine, button);
            },
            (error: unknown) => setEditor({ error }),
          );
        }}
      />
      <MachineEditor
        loaded={editor}
        machine={editing.shown}
        open={editing.target !== null}
        session={session}
        onClose={editing.close}
        onCloseAutoFocus={editing.restoreFocus}
        onRevoked={setGone}
        onSaved={(machine) => {
          setSaved({ id: session, machine });
          editing.close();
        }}
      />
      {/* Unmounted on close: a confirmation reopened while the previous one
          exits must not sit beneath it. */}
      {revocation.target && (
        <RevokeConfirmation
          machine={revocation.target}
          now={now}
          onCancel={revocation.close}
          onConfirm={() => {
            const target = revocation.target;
            if (target && revoke(target)) revocation.close();
          }}
          onClose={revocation.restoreFocus}
        />
      )}
    </div>
  );
}
