import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  Check,
  CircleAlert,
  Eraser,
  Layers,
  MoreHorizontal,
  RefreshCw,
} from 'lucide-react';
import { useRef } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Item, ItemContent, ItemMedia, ItemTitle } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { describeFailure } from './api-client';
import { agentsIn } from './bucket-format';
import { parentBuckets } from './bucket-tree';
import { DismissibleAlert, LoadFailure } from './failure';
import { memoryOptions, memoryWriteGate } from './memory-api';
import type { ForgetSubject } from './memory-forget-api';
import { principalName } from './memory-format';
import type { MemoryPageModel } from './use-memory-page';

export function MemoryActions({
  subject,
  model,
  pane = false,
}: {
  subject: ForgetSubject;
  model: MemoryPageModel;
  pane?: boolean;
}) {
  const queries = useQueryClient();
  const trigger = useRef<HTMLButtonElement>(null);
  const prefetch = () =>
    memoryWriteGate.preload(queries, memoryOptions(subject.id));
  return (
    <DropdownMenu onOpenChange={(open) => open && prefetch()}>
      <DropdownMenuTrigger asChild>
        <Button
          ref={trigger}
          variant={pane ? 'outline' : 'ghost'}
          size="icon-sm"
          disabled={model.busy}
          aria-label={pane ? 'More actions' : `Actions for ${subject.title}`}
          data-memory-actions={pane ? undefined : subject.id}
          onPointerEnter={prefetch}
          onFocus={prefetch}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={pane ? 'w-48' : 'w-64'}>
        {!pane && (
          <>
            <DropdownMenuLabel className="flex min-w-0 flex-col font-normal">
              <span className="line-clamp-2 text-sm font-medium wrap-anywhere">
                {subject.title}
              </span>
              <span className="flex min-w-0 gap-1 text-xs text-muted-foreground">
                <span className="min-w-0 truncate font-mono">
                  {subject.bucket}
                </span>
                <MenuVersion version={subject.version} />
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => {
            const known = queries.getQueryData(
              memoryOptions(subject.id).queryKey,
            );
            const version =
              Math.max(subject.version ?? 0, known?.version ?? 0) || undefined;
            model.forget.open({ ...subject, version }, trigger.current);
          }}
        >
          <Eraser />
          Forget memory…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
function MenuVersion({ version }: { version?: number }) {
  return version === undefined ? null : (
    <span className="shrink-0">
      · {version} {version === 1 ? 'version' : 'versions'}
    </span>
  );
}
function useForgetDetail(
  shown: ForgetSubject | null,
  target: ForgetSubject | null,
  busy: boolean,
) {
  const queries = useQueryClient();
  return useQuery(
    memoryWriteGate.queryOptions(
      {
        ...memoryOptions(shown?.id ?? ''),
        enabled: Boolean(target && shown?.version === undefined),
      },
      busy,
      queries,
    ),
  );
}
function versions(version?: number) {
  if (version === undefined) return 'all its versions';
  return version === 1 ? 'its only version' : `all ${version} versions`;
}
export function ForgetDialog({ model }: { model: MemoryPageModel }) {
  const { target, shown } = model.forget;
  const detail = useForgetDetail(shown, target, model.busy);
  if (!shown) return null;
  const version = shown.version ?? detail.data?.version;
  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => !open && model.forget.cancel()}
    >
      <AlertDialogContent
        onCloseAutoFocus={model.forget.restoreFocus}
        className="max-h-dvh overflow-y-auto"
      >
        <AlertDialogHeader>
          <AlertDialogMedia>
            <Eraser />
          </AlertDialogMedia>
          <AlertDialogTitle className="wrap-anywhere">
            Forget “{shown.title}”?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Nook deletes it permanently. This can’t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="grid gap-2">
          <li>
            <Item variant="muted" size="sm">
              <ItemMedia variant="icon">
                <Layers />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>What is deleted</ItemTitle>
                <p className="text-sm text-pretty text-muted-foreground">
                  This memory, {versions(version)}, and its keyword and meaning
                  search entries.
                </p>
              </ItemContent>
            </Item>
          </li>
          <li>
            <Item variant="muted" size="sm">
              <ItemMedia variant="icon">
                <Bot />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Who loses it</ItemTitle>
                <p className="text-sm text-pretty text-muted-foreground wrap-anywhere">
                  {agentsIn(
                    shown.bucket,
                    parentBuckets(
                      model.buckets.data?.map((row) => row.path) ?? [],
                    ).has(shown.bucket),
                    <span className="font-mono">{shown.bucket}</span>,
                  )}
                  . They can’t get it or find it in search anymore.
                  {shown.bucket !== model.bucket && (
                    <>
                      {' '}
                      It is stored in{' '}
                      <span className="font-mono">{shown.bucket}</span>, not in{' '}
                      <span className="font-mono">{model.bucket}</span>.
                    </>
                  )}
                </p>
              </ItemContent>
            </Item>
          </li>
        </ul>
        <VersionNote
          version={version}
          error={detail.error}
          retrying={detail.isFetching}
          retry={() => void detail.refetch()}
        />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={version === undefined || model.busy}
            onClick={() =>
              version !== undefined && model.forget.confirm(version)
            }
          >
            Forget memory
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
function VersionNote({
  version,
  error,
  retrying,
  retry,
}: {
  version?: number;
  error: Error | null;
  retrying: boolean;
  retry: () => void;
}) {
  if (version !== undefined)
    return (
      <p className="text-xs text-muted-foreground">
        You are forgetting version {version}, the newest version Nook has
        loaded. If it changes before Nook deletes it, nothing is deleted.
      </p>
    );
  if (error)
    return (
      <LoadFailure
        title="Could not load this memory"
        description={describeFailure(error, 'read memories')}
        cached={true}
        retrying={retrying}
        onRetry={retry}
        retryLabel="Retry memory"
      />
    );
  return <Skeleton aria-label="Loading version" className="h-4 w-full" />;
}
export function pendingRows<Row extends { id: string }>(
  rows: readonly Row[],
  model: MemoryPageModel,
): ({ kind: 'memory'; row: Row } | { kind: 'pending'; title: string })[] {
  const entry = model.forget.entry;
  const result: (
    | { kind: 'memory'; row: Row }
    | { kind: 'pending'; title: string }
  )[] = rows.map((row) => ({ kind: 'memory', row }));
  if (
    entry?.status !== 'pending' ||
    !entry.inRows ||
    entry.viewBucket !== model.bucket ||
    entry.query !== model.q ||
    entry.scope !== model.scope
  )
    return result;
  const filtered = result.filter(
    (item) => item.kind !== 'memory' || item.row.id !== entry.subject.id,
  );
  const index = filtered.findIndex(
    (item) => item.kind === 'memory' && item.row.id === entry.before,
  );
  filtered.splice(index < 0 ? filtered.length : index, 0, {
    kind: 'pending',
    title: entry.subject.title,
  });
  return filtered;
}
export function ForgettingRow({ title }: { title: string }) {
  return (
    <li className="border-b">
      <div
        role="status"
        className="flex h-9 min-w-0 items-center gap-2 px-4 text-xs text-muted-foreground"
      >
        <Spinner />
        <span className="min-w-0 truncate">
          Forgetting <span className="font-medium">{title}</span>…
        </span>
      </div>
    </li>
  );
}
export function ForgetProblem({
  model,
  id,
  pane = false,
}: {
  model: MemoryPageModel;
  id: string;
  pane?: boolean;
}) {
  const entry = model.forget.entry;
  if (entry?.subject.id !== id || !['failed', 'changed'].includes(entry.status))
    return null;
  if (!pane && model.desktop && model.selected?.id === id) return null;
  return (
    <div className={pane ? 'mb-5 max-w-3xl' : 'px-4 pb-3'}>
      <ProblemAlert model={model} entry={entry} />
    </div>
  );
}
type ProblemEntry = NonNullable<MemoryPageModel['forget']['entry']>;
function problemCopy(
  entry: ProblemEntry,
  current: MemoryPageModel['forget']['current'],
) {
  if (entry.status === 'failed')
    return `${entry.subject.title} was not forgotten. ${
      entry.error
        ? describeFailure(
            entry.error,
            'forget memories',
            'Nothing was deleted.',
          )
        : 'It is still stored with the version you last saw. Nothing was deleted.'
    }`;
  return `${current ? principalName(current) : 'Another writer'} saved version ${current?.version ?? 'a newer version'} while you were deciding, not ${entry.subject.version}. Nothing was deleted.`;
}
function ProblemAction({
  model,
  entry,
}: {
  model: MemoryPageModel;
  entry: ProblemEntry;
}) {
  const current = model.forget.current;
  if (entry.status === 'failed')
    return (
      <Button variant="outline" size="xs" onClick={model.forget.retry}>
        <RefreshCw />
        Try again
      </Button>
    );
  if (!current)
    return (
      <Button
        variant="outline"
        size="xs"
        disabled={model.forget.checking}
        onClick={() => void model.forget.refreshCurrent()}
      >
        Refresh memory
      </Button>
    );
  return (
    <Button
      variant="outline"
      size="xs"
      onClick={(event) =>
        model.forget.open(
          { ...entry.subject, version: current.version },
          event.currentTarget,
        )
      }
    >
      {`Forget version ${current.version}…`}
    </Button>
  );
}
export function UnconfirmedForget({ model }: { model: MemoryPageModel }) {
  const entry = model.forget.entry;
  if (entry?.status !== 'unconfirmed' || entry.viewBucket !== model.bucket)
    return null;
  return (
    <div className="p-3">
      <DismissibleAlert
        icon={<CircleAlert />}
        title="Forget not confirmed"
        onDismiss={model.forget.keep}
      >
        <p>
          {describeFailure(
            entry.error,
            'forget memories',
            `${entry.subject.title} may already be gone. Nook could not confirm the result.`,
          )}
        </p>
        <Button
          variant="outline"
          size="xs"
          disabled={model.forget.checking}
          onClick={() => void model.forget.check()}
        >
          Check again
        </Button>
      </DismissibleAlert>
    </div>
  );
}
export function ForgetReadFailure({ model }: { model: MemoryPageModel }) {
  if (!model.forget.readFailure || model.forget.entry?.status === 'unconfirmed')
    return null;
  return (
    <div className="p-3">
      <DismissibleAlert
        destructive
        icon={<CircleAlert />}
        title="Could not check this memory"
        onDismiss={model.forget.dismissReadFailure}
      >
        {describeFailure(model.forget.readFailure, 'read memories')}
      </DismissibleAlert>
    </div>
  );
}
function ProblemAlert({
  model,
  entry,
}: {
  model: MemoryPageModel;
  entry: ProblemEntry;
}) {
  const failed = entry.status === 'failed';
  return (
    <Alert variant={failed ? 'destructive' : 'default'} role="alert">
      {failed ? <CircleAlert /> : <RefreshCw />}
      <AlertTitle>
        {failed ? 'Not forgotten' : 'Not forgotten: it changed'}
      </AlertTitle>
      <AlertDescription>
        <p>{problemCopy(entry, model.forget.current)}</p>
        <div className="mt-2 flex flex-wrap gap-2 text-foreground">
          <ProblemAction model={model} entry={entry} />
          <Button variant="ghost" size="xs" onClick={model.forget.keep}>
            Keep it
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
export function ForgetNotice({ model }: { model: MemoryPageModel }) {
  const notice = model.forget.notice;
  if (!notice || notice.viewBucket !== model.bucket) return null;
  return (
    <span className="flex min-w-0 items-center gap-1">
      <Check className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">Forgot {notice.title}</span>
    </span>
  );
}
