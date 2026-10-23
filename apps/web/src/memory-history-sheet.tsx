import {
  type Memory,
  type MemoryVersion,
  memoryTitle,
  type OwnerMemory,
} from '@nook/contract';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, ChevronLeft, ChevronRight, Diff } from 'lucide-react';
import { lazy, type RefObject, Suspense, useEffect, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Item, ItemActions, ItemContent } from '@/components/ui/item';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { describeFailure } from './api-client';
import { LoadFailure } from './failure';
import {
  historyBehind,
  memoryHistoryOptions,
  memoryKeys,
  memoryWriteGate,
} from './memory-api';
import { Provenance } from './memory-format';
import {
  changeSummary,
  principalLabel,
  tagChanges,
} from './memory-history-format';
import { MemoryMarkdown } from './memory-markdown';
import { formatDateTime, timeAgo } from './time';
import type { MemoryPageModel } from './use-memory-page';

function useMemoryHistory(detail: OwnerMemory) {
  const queries = useQueryClient();
  const busy = memoryWriteGate.useBusy();
  const history = useQuery(
    memoryWriteGate.queryOptions(
      memoryHistoryOptions(detail.id, detail.version),
      busy,
      queries,
    ),
  );
  const reconciled = useRef(0);
  const behind = historyBehind(history.data, detail.version);
  useEffect(() => {
    if (
      !history.data?.[0] ||
      busy ||
      memoryWriteGate.isWriting(queries) ||
      !behind ||
      history.isFetching ||
      history.isError ||
      reconciled.current === detail.version
    )
      return;
    reconciled.current = detail.version;
    void history.refetch();
  }, [
    history.data,
    behind,
    detail.version,
    history.isFetching,
    history.isError,
    history.refetch,
    queries,
    busy,
  ]);
  const head = history.data?.[0];
  const memory =
    head && head.version > detail.version
      ? { ...detail, ...head, updatedAt: head.provenance.at }
      : detail;
  useEffect(() => {
    if (memory.version > detail.version)
      queries.setQueryData(memoryKeys.detail(memory.id), memory);
  }, [queries, detail, memory]);
  return {
    memory,
    history: {
      ...history,
      isPending: history.isPending || (!history.isError && behind),
    },
  };
}

const ChangesView = lazy(() =>
  import('./memory-diff').then((module) => ({ default: module.ChangesView })),
);
type HistoryModel = MemoryPageModel & {
  history: Pick<
    ReturnType<typeof useQuery<MemoryVersion[]>>,
    'data' | 'error' | 'isPending' | 'isFetching' | 'isError' | 'refetch'
  >;
};

function VersionRows({
  versions,
  current,
  model,
}: {
  versions: readonly MemoryVersion[];
  current: number;
  model: HistoryModel;
}) {
  return (
    <ol className="divide-y" aria-label="Versions, newest first">
      {versions.map((version, index) => {
        const previous = versions[index + 1];
        return (
          <li key={version.version}>
            <Item asChild size="sm" className="w-full min-w-0 min-h-21">
              <Link
                to="/memory"
                search={{
                  ...model.search,
                  history: '1',
                  version: version.version,
                }}
                data-version-row={version.version}
              >
                <ItemContent className="min-w-0">
                  <div className="space-y-0.5">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                      <span className="font-medium">
                        Version {version.version}
                      </span>
                      {version.version === current && (
                        <Badge variant="secondary">Current</Badge>
                      )}
                      <time
                        dateTime={version.provenance.at}
                        title={timeAgo(version.provenance.at)}
                        className="ml-auto text-xs text-muted-foreground tabular-nums"
                      >
                        {formatDateTime(version.provenance.at)}
                      </time>
                    </span>
                    <span
                      title={principalLabel(version)}
                      className="mt-0.5 block truncate text-xs text-muted-foreground"
                    >
                      {principalLabel(version)}
                    </span>
                    <span className="mt-0.5 block text-xs">
                      {changeSummary(version, previous)}
                    </span>
                  </div>
                </ItemContent>
                <ItemActions>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </ItemActions>
              </Link>
            </Item>
          </li>
        );
      })}
    </ol>
  );
}
function RowsSkeleton() {
  return (
    <div role="status" aria-label="Loading history" className="divide-y">
      {['a', 'b', 'c', 'd'].map((id) => (
        <div
          key={id}
          data-history-skeleton-row
          className="min-h-21 space-y-1 px-4 py-3"
        >
          <div className="flex justify-between">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-32" />
          </div>
          <Skeleton className="h-3 w-48" />
          <Skeleton className="h-3 w-20" />
        </div>
      ))}
    </div>
  );
}
function HistoryFailure({ model }: { model: HistoryModel }) {
  const queries = useQueryClient();
  return (
    <div className="p-4">
      <LoadFailure
        title="Could not load history"
        description={describeFailure(model.history.error, 'read memories')}
        cached={false}
        retrying={model.history.isFetching}
        disabled={model.busy}
        onRetry={() =>
          memoryWriteGate.start(queries, () => void model.history.refetch())
        }
        retryLabel="Retry history"
      />
    </div>
  );
}

function Tags({
  version,
  previous,
  changes,
}: {
  version: MemoryVersion;
  previous?: MemoryVersion;
  changes: boolean;
}) {
  const { added, removed } = tagChanges(previous?.tags ?? [], version.tags);
  const diff = changes && previous;
  const shown = diff ? [...version.tags, ...removed] : version.tags;
  if (!shown.length) return null;
  return (
    <div data-memory-tags className="mt-4 flex flex-wrap gap-1.5">
      {shown.map((tag) => {
        const kind = !diff
          ? 'plain'
          : removed.includes(tag)
            ? 'removed'
            : added.includes(tag)
              ? 'added'
              : 'plain';
        return (
          <Badge key={tag} variant={kind === 'plain' ? 'secondary' : kind}>
            {kind === 'added' && <span className="sr-only">Added tag </span>}
            {kind === 'removed' && (
              <span className="sr-only">Removed tag </span>
            )}
            {tag}
          </Badge>
        );
      })}
    </div>
  );
}
function VersionBody({
  version,
  previous,
  changes,
  current,
}: {
  version: MemoryVersion;
  previous?: MemoryVersion;
  changes: boolean;
  current: number;
}) {
  return (
    <div className="px-4 pt-3 pb-10">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold tracking-tight">
          Version {version.version}
          <span className="font-normal text-muted-foreground">
            {' '}
            of {current}
          </span>
        </h3>
        {version.version === current && (
          <Badge variant="secondary">Current</Badge>
        )}
      </div>
      <p className="mt-1 text-sm text-muted-foreground wrap-anywhere">
        {memoryTitle(version.content)}
      </p>
      <Provenance
        provenance={version.provenance}
        label={previous ? 'Updated' : 'Stored'}
      />
      <Tags version={version} previous={previous} changes={changes} />
      <div className="mt-6">
        {changes && previous ? (
          <Suspense fallback={<Skeleton className="h-40 w-full" />}>
            <ChangesView
              key={version.version}
              before={previous}
              after={version}
            />
          </Suspense>
        ) : (
          <MemoryMarkdown content={version.content} />
        )}
      </div>
    </div>
  );
}
function comparisonLabel(
  version: MemoryVersion | undefined,
  previous: MemoryVersion | undefined,
  changes: boolean,
) {
  if (!version) return '';
  if (!previous) return 'First version, nothing to compare';
  return changes
    ? `Compared with version ${previous.version}`
    : 'Full text of this version';
}
function VersionView({
  model,
  memory,
  selected,
}: {
  model: HistoryModel;
  memory: Memory;
  selected: number;
}) {
  const versions = model.history.data;
  const version = versions?.find((v) => v.version === selected);
  const previous = versions?.find((v) => v.version === selected - 1);
  const newer = versions?.find((v) => v.version === selected + 1);
  const older = previous;
  return (
    <>
      <SheetTitle className="sr-only">Version {selected}</SheetTitle>
      <div className="flex shrink-0 items-center gap-1 py-2 pr-14 pl-2">
        <Button variant="ghost" size="sm" onClick={model.showAllVersions}>
          <ArrowLeft />
          All versions
        </Button>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Older version"
            disabled={!older}
            onClick={() => older && model.selectVersion(older.version)}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Newer version"
            disabled={!newer}
            onClick={() => newer && model.selectVersion(newer.version)}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>
      <Separator />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="sticky top-0 z-10 flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-background px-4 py-1.5">
          <Button
            variant={model.changes ? 'secondary' : 'outline'}
            size="sm"
            aria-pressed={model.changes}
            disabled={!previous}
            onClick={model.toggleChanges}
          >
            <Diff />
            Show changes
          </Button>
          <span className="text-xs text-muted-foreground">
            {comparisonLabel(version, previous, model.changes)}
          </span>
        </div>
        {model.history.isPending ? (
          <div
            role="status"
            aria-label="Loading version"
            className="space-y-4 px-4 py-5"
          >
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : model.history.isError ? (
          <HistoryFailure model={model} />
        ) : !version ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            <p>Version {selected} does not exist.</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={model.showAllVersions}
            >
              All versions
            </Button>
          </div>
        ) : (
          <VersionBody
            version={version}
            previous={previous}
            changes={model.changes}
            current={memory.version}
          />
        )}
      </div>
    </>
  );
}
function ListView({ model, memory }: { model: HistoryModel; memory: Memory }) {
  const count = memory.version;
  return (
    <>
      <SheetHeader className="shrink-0">
        <div className="pr-8">
          <SheetTitle>History</SheetTitle>
          <SheetDescription className="wrap-anywhere">
            {count === 1
              ? `“${memoryTitle(memory.content)}” has not changed since it was stored.`
              : `${count} versions of “${memoryTitle(memory.content)}”, newest first. Agents write new versions; earlier ones stay as they were.`}
          </SheetDescription>
        </div>
      </SheetHeader>
      <Separator />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {model.history.isPending ? (
          <RowsSkeleton />
        ) : model.history.isError ? (
          <HistoryFailure model={model} />
        ) : (
          <VersionRows
            versions={model.history.data ?? []}
            current={memory.version}
            model={model}
          />
        )}
      </div>
    </>
  );
}
export function HistorySheet({
  model: pageModel,
  memory: detail,
  returnFocus,
}: {
  model: MemoryPageModel;
  memory: OwnerMemory;
  /** The History button that opened the sheet; focus goes back to it on close. */
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const { memory, history } = useMemoryHistory(detail);
  const model = { ...pageModel, history };
  return (
    <Sheet
      open={model.historyOpen}
      onOpenChange={(open) => {
        if (!open) model.closeHistory();
      }}
    >
      <SheetContent
        data-history-sheet
        className="w-full sm:max-w-xl"
        layout="stacked"
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement).focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus.current?.focus({ preventScroll: true });
        }}
      >
        {model.version !== undefined ? (
          <VersionView model={model} memory={memory} selected={model.version} />
        ) : (
          <ListView model={model} memory={memory} />
        )}
      </SheetContent>
    </Sheet>
  );
}
