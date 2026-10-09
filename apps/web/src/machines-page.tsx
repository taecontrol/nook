import type { Machine } from '@nook/contract';
import {
  Activity,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Hourglass,
  MonitorSmartphone,
  ServerCrash,
  X,
} from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { ApiError } from './api-client';
import { MachineAccess } from './grant-summary';
import { type MachineRevoke, useMachines } from './machines-api';
import { approvedText, groupMachines, lastUsedParts } from './machines-model';
import { formatDate } from './paths';

const icons = { stale: Hourglass, never: CircleDashed, recent: Activity };
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
function loadProblem(error: Error | null) {
  if (error instanceof ApiError && error.status === 401)
    return 'Your owner session expired. Sign in again, then try again.';
  if (error instanceof ApiError && error.status === 403)
    return "Only this installation's owner can manage machines.";
  return 'Nook is unavailable right now (503).';
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
function LoadFailure({
  error,
  retrying,
  onRetry,
  cached,
}: {
  error: Error | null;
  retrying: boolean;
  onRetry: () => void;
  cached: boolean;
}) {
  const retry = (
    <Button variant="outline" size="sm" disabled={retrying} onClick={onRetry}>
      {retrying && <Spinner />}Try again
    </Button>
  );
  if (cached)
    return (
      <Alert variant="destructive" className="mb-6">
        <ServerCrash />
        <AlertTitle>Couldn't refresh machines</AlertTitle>
        <AlertDescription>
          Showing the last loaded machines. {loadProblem(error)}
          {retry}
        </AlertDescription>
      </Alert>
    );
  return (
    <div className="rounded-lg border border-dashed">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ServerCrash />
          </EmptyMedia>
          <EmptyTitle>Couldn't load machines</EmptyTitle>
          <EmptyDescription>
            {loadProblem(error)} Try again in a moment.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>{retry}</EmptyContent>
      </Empty>
    </div>
  );
}
function MachineGroups({
  machines,
  now,
  busy,
  onRevoke,
}: {
  machines: readonly Machine[];
  now: number;
  busy: boolean;
  onRevoke: (machine: Machine, trigger: HTMLButtonElement) => void;
}) {
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
                      <ItemTitle className="w-full wrap-anywhere">
                        {machine.name}
                      </ItemTitle>
                      <ItemDescription>
                        <Facts parts={lastUsedParts(machine, now)} />
                      </ItemDescription>
                      <ItemDescription truncate={false}>
                        <Facts parts={[approvedText(machine, now)]} /> ·{' '}
                        <MachineAccess grant={machine.grant} />
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions className="self-start sm:self-center">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        aria-label={`Revoke ${machine.name}, ${approvedText(machine, now).toLowerCase()}`}
                        onClick={(event) =>
                          onRevoke(machine, event.currentTarget)
                        }
                      >
                        Revoke
                      </Button>
                    </ItemActions>
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
  if (write.status === 'success') return 'Revoked ';
  if (write.error instanceof ApiError && write.error.outcomeUnknown)
    return "Couldn't confirm revocation of ";
  return "Couldn't revoke ";
}
function revokeProblem(error: Error | null) {
  if (error instanceof ApiError && error.outcomeUnknown)
    return `${loadProblem(error)} The machine may already be revoked. Try again to confirm it is revoked.`;
  return `${loadProblem(error)} Check the machine list before trying again.`;
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
  if (write.status === 'pending')
    return (
      <Alert>
        <Spinner />
        <AlertTitle>
          Revoking <span className="wrap-anywhere">{machine.name}</span>…
        </AlertTitle>
      </Alert>
    );
  const failed = write.status === 'error';
  return (
    <Alert variant={failed ? 'destructive' : 'default'}>
      {failed ? <CircleAlert /> : <CircleCheck />}
      <AlertTitle className="mr-6">
        {revokeHeading(write)}
        <span className="wrap-anywhere">{machine.name}</span>
      </AlertTitle>
      <AlertDescription>
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
        ) : (
          <>
            <p>
              The token approved {formatDate(machine.approvedAt)} is deleted.
              That machine's next request to Nook will fail. To reconnect it,
              run this on it and approve it again:
            </p>
            <div className="mt-1">
              <LoginCommand />
            </div>
          </>
        )}
      </AlertDescription>
      <Button
        variant="ghost"
        size="icon-xs"
        className="absolute top-2.5 right-2.5"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <X />
      </Button>
    </Alert>
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
}: {
  state: ReturnType<typeof useMachines>;
  now: number;
  onRevoke: (machine: Machine, trigger: HTMLButtonElement) => void;
}) {
  const { machines, busy } = state;
  if (machines.isPending) return <MachinesSkeleton />;
  const failure = (
    <LoadFailure
      error={machines.error}
      retrying={machines.isFetching}
      onRetry={() => machines.refetch()}
      cached={machines.data !== undefined}
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
        />
      )}
    </>
  );
}
export function MachinesPage() {
  const state = useMachines();
  const { machines, write, busy, revoke } = state;
  const [target, setTarget] = useState<Machine | null>(null);
  const [dismissed, setDismissed] = useState<number>();
  const [, tick] = useState(0);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  // Relative times and the 30-day boundary also advance on an idle open page.
  useEffect(() => {
    const timer = setInterval(() => tick((value) => value + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  const now = Date.now();
  const list = machines.data;
  const confirm = (machine: Machine, button: HTMLButtonElement) => {
    if (busy) return;
    trigger.current = button;
    setTarget(machine);
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
          Every machine that holds a Nook token, grouped by last use. The ones
          you may no longer use come first.
        </p>
      ) : (
        <div className="h-4" />
      )}
      <div aria-live="polite" className="empty:hidden mb-6">
        {write && write.id !== dismissed && (
          <RevokeFeedback
            write={write}
            onDismiss={() => setDismissed(write.id)}
            onRetry={confirm}
          />
        )}
      </div>
      <MachineList state={state} now={now} onRevoke={confirm} />
      {target && (
        <RevokeConfirmation
          machine={target}
          now={now}
          onCancel={() => setTarget(null)}
          onConfirm={() => {
            if (target && revoke(target)) setTarget(null);
          }}
          onClose={(event) => {
            event.preventDefault();
            if (trigger.current?.isConnected) trigger.current.focus();
            else heading.current?.focus();
          }}
        />
      )}
    </div>
  );
}
