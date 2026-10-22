import {
  type MemoryListItem,
  memoryTitle,
  type OwnerMemory,
} from '@nook/contract';
import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import {
  ArrowLeft,
  BookOpen,
  ChevronRight,
  History,
  Paperclip,
} from 'lucide-react';
import { lazy, type RefObject, Suspense, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Item, ItemContent, ItemTitle } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ApiError, describeFailure } from './api-client';
import { BucketTree, BucketTreeSkeleton } from './bucket-tree';
import { LoadFailure } from './failure';
import {
  ForgetDialog,
  ForgetProblem,
  ForgetReadFailure,
  ForgettingRow,
  MemoryActions,
  pendingRows,
  UnconfirmedForget,
} from './memory-forget';
import { Provenance, principalName } from './memory-format';
import { MemoryMarkdown } from './memory-markdown';
import { memorySearch } from './memory-navigation';
import { ColumnSummary, SearchBody, SearchField } from './memory-search';
import { formatDateTime, recentTime } from './time';
import { type MemoryPageModel, useMemoryPage } from './use-memory-page';
import './memory.css';

const loadHistory = () => import('./memory-history-sheet');
const HistorySheet = lazy(() =>
  loadHistory().then((module) => ({ default: module.HistorySheet })),
);

const loadFiles = () => import('./memory-files-sheet');
const FilesSheet = lazy(() =>
  loadFiles().then((module) => ({ default: module.FilesSheet })),
);

function BucketNav({ model }: { model: MemoryPageModel }) {
  return (
    <nav aria-label="Memory buckets" data-memory-buckets className="px-3 pt-3">
      <div className="flex items-center justify-between border-b pb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <span>Buckets</span>
        <span className="normal-case tracking-normal">Memories</span>
      </div>
      <div className="py-2">
        {model.buckets.isPending ? (
          <BucketTreeSkeleton />
        ) : model.buckets.isError ? (
          <LoadFailure
            title="Could not load buckets"
            description={describeFailure(model.buckets.error, 'read buckets')}
            cached={false}
            retrying={model.buckets.isFetching}
            onRetry={() => void model.buckets.refetch()}
            retryLabel="Retry buckets"
          />
        ) : (
          <BucketTree
            buckets={model.buckets.data.map((row) => row.path)}
            selected={model.browse ? null : model.bucket}
            counts={model.counts}
            loading={model.countsQuery.isPending}
            to="/memory"
            noun="memory"
            scope={model.scope}
            query={model.q || undefined}
          />
        )}
      </div>
      {model.countsQuery.isError && (
        <LoadFailure
          title="Could not load memory counts"
          className="mb-3"
          description={describeFailure(
            model.countsQuery.error,
            'read memory counts',
          )}
          cached={Boolean(model.countsQuery.data)}
          retrying={model.countsQuery.isFetching}
          disabled={model.busy}
          onRetry={model.retryCounts}
          retryLabel="Retry counts"
        />
      )}
      <p className="border-t py-3 text-xs leading-5 text-muted-foreground">
        Open a bucket to see what agents working there can remember.
      </p>
    </nav>
  );
}
function MemoryRow({
  memory,
  model,
}: {
  memory: MemoryListItem;
  model: MemoryPageModel;
}) {
  const inherited = memory.bucket !== model.bucket;
  const selected = model.search.memory === memory.id;
  return (
    <li className={cn('border-b', selected && 'bg-accent')}>
      <div className="flex min-w-0 items-center gap-1 pr-3">
        <Item asChild size="sm" className="min-w-0 flex-1">
          <Link
            to="/memory"
            search={memorySearch(model, { memory: memory.id })}
            className="focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
            data-memory-row={memory.id}
            data-inherited={inherited ? 'true' : undefined}
            title={memory.title}
            aria-current={selected ? 'true' : undefined}
          >
            <ItemContent className="min-w-0">
              <ItemTitle className="block min-w-0 max-w-full">
                <span className="block truncate">{memory.title}</span>
              </ItemTitle>
              <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                <span
                  title={memory.bucket}
                  className={cn(
                    'max-w-24 truncate font-mono',
                    inherited && 'font-semibold text-foreground',
                  )}
                >
                  {memory.bucket}
                </span>
                <span aria-hidden>·</span>
                <span
                  className="shrink-0 tabular-nums"
                  title={formatDateTime(memory.createdAt)}
                >
                  {recentTime(memory.createdAt)}
                </span>
                <span aria-hidden>·</span>
                <span className="min-w-0 truncate">
                  {principalName(memory)}
                </span>
              </div>
            </ItemContent>
          </Link>
        </Item>
        <MemoryActions subject={memory} model={model} />
      </div>
      <ForgetProblem model={model} id={memory.id} />
    </li>
  );
}
function ListSkeleton() {
  return (
    <div role="status" aria-label="Loading memories" className="divide-y">
      {['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, i) => (
        <div key={id} className="space-y-2 px-4 py-4">
          <Skeleton className={cn('h-4', i % 2 ? 'w-4/5' : 'w-3/5')} />
          <Skeleton className="h-3 w-2/5" />
        </div>
      ))}
    </div>
  );
}
function emptyListCopy(model: MemoryPageModel) {
  return model.scope === 'bucket'
    ? `There are no memories stored in ${model.bucket}. Include inherited to see memories from its ancestors.`
    : `There are no memories visible in ${model.bucket}. Agents can store new memories with remember.`;
}
function EmptyList({ model }: { model: MemoryPageModel }) {
  const forgotten = model.forget.notice?.viewBucket === model.bucket;
  return (
    <div className="px-5 py-16">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BookOpen />
          </EmptyMedia>
          <EmptyTitle>
            {forgotten ? 'No memories left' : 'No memories yet'}
          </EmptyTitle>
          <EmptyDescription>
            {forgotten ? (
              emptyListCopy(model)
            ) : model.firstRun ? (
              <>
                <span>Agents have not stored any memories yet.</span> Use MCP{' '}
                <code>remember</code> to store one in a bucket.
              </>
            ) : model.scope === 'bucket' ? (
              emptyListCopy(model)
            ) : (
              `Agents working in ${model.bucket} have no memories to read yet.`
            )}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
function ListBody({ model }: { model: MemoryPageModel }) {
  if (model.list.isPending) return <ListSkeleton />;
  if (model.list.isError)
    return (
      <div className="p-3">
        <LoadFailure
          title="Could not load memories"
          description={describeFailure(model.list.error, 'read memories')}
          cached={false}
          retrying={model.list.isFetching}
          disabled={model.busy}
          onRetry={model.retryList}
        />
      </div>
    );
  const rows = pendingRows(model.records, model);
  if (!rows.length) return <EmptyList model={model} />;
  return (
    <>
      <ul>
        {rows.map((entry) =>
          entry.kind === 'pending' ? (
            <ForgettingRow key="pending" title={entry.title} />
          ) : (
            <MemoryRow key={entry.row.id} memory={entry.row} model={model} />
          ),
        )}
      </ul>
      {model.list.hasNextPage && (
        <div className="p-3 text-center">
          <Button
            variant="outline"
            size="sm"
            disabled={model.busy || model.list.isFetching}
            onClick={model.loadMore}
          >
            {model.list.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </>
  );
}
function MemoryList({ model }: { model: MemoryPageModel }) {
  return (
    <section
      data-memory-list
      aria-label={`Memories visible in ${model.bucket}`}
      className={cn(
        'min-w-0',
        (model.browse || model.detailOpen) && 'max-lg:hidden',
      )}
    >
      <div className="sticky top-0 z-10 border-b bg-background px-4 py-3">
        <div
          title={model.bucket}
          data-memory-list-heading
          tabIndex={-1}
          className="line-clamp-2 font-mono text-sm font-semibold wrap-anywhere"
        >
          {model.bucket}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {model.scope === 'inherited'
            ? 'Memories here and from ancestors'
            : 'Memories stored in this bucket'}
        </p>
        <SearchField model={model} />
        <fieldset className="mt-2 flex gap-1" aria-label="Memory scope">
          <Button
            variant={model.scope === 'bucket' ? 'secondary' : 'ghost'}
            size="xs"
            aria-pressed={model.scope === 'bucket'}
            onClick={() => model.changeScope('bucket')}
          >
            Only this bucket
          </Button>
          <Button
            variant={model.scope === 'inherited' ? 'secondary' : 'ghost'}
            size="xs"
            aria-pressed={model.scope === 'inherited'}
            onClick={() => model.changeScope('inherited')}
          >
            Include inherited
          </Button>
        </fieldset>
      </div>
      <ColumnSummary model={model} />
      <UnconfirmedForget model={model} />
      <ForgetReadFailure model={model} />
      {model.searching ? (
        <SearchBody model={model} />
      ) : (
        <ListBody model={model} />
      )}
    </section>
  );
}
function emptyReading(model: MemoryPageModel) {
  if (model.forget.notice?.viewBucket === model.bucket && !model.records.length)
    return {
      title: 'Nothing to read',
      description: `No memories are stored in ${model.bucket}.`,
    };
  return {
    title: 'Choose a memory',
    description:
      'Select a memory to read its full content and see who stored it.',
  };
}
function ReadingState({ model }: { model: MemoryPageModel }) {
  if (model.search.memory && model.detail.isPending)
    return (
      <div
        role="status"
        aria-label="Loading memory"
        className="space-y-4 px-8 py-7"
      >
        <Skeleton className="h-7 w-4/5" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  if (
    model.detail.isError &&
    !(
      model.detail.error instanceof ApiError &&
      model.detail.error.status === 404
    )
  )
    return (
      <div className="min-w-0 flex-1 px-8 py-12">
        <LoadFailure
          title="Could not load memory"
          description={describeFailure(model.detail.error, 'read memories')}
          cached={false}
          retrying={model.detail.isFetching}
          disabled={model.busy}
          onRetry={model.retryDetail}
          retryLabel="Retry memory"
        />
      </div>
    );
  const empty = emptyReading(model);
  return (
    <section
      aria-label="Reading pane"
      className="flex min-w-0 flex-1 items-center justify-center px-8 text-center"
    >
      <Empty className="max-w-sm">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BookOpen />
          </EmptyMedia>
          <EmptyTitle>{empty.title}</EmptyTitle>
          <EmptyDescription>{empty.description}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </section>
  );
}
function MemoryBack({ model }: { model: MemoryPageModel }) {
  return (
    <div className="sticky top-0 z-10 border-b bg-background px-5 py-3 lg:hidden">
      <Button asChild variant="ghost" size="sm">
        <Link to="/memory" search={memorySearch(model)}>
          <ArrowLeft />
          {model.q ? 'Results' : 'Memories'}
        </Link>
      </Button>
    </div>
  );
}
function ReadingActions({
  model,
  memory,
  filesFocus,
  historyFocus,
}: {
  model: MemoryPageModel;
  memory: OwnerMemory;
  filesFocus: RefObject<HTMLButtonElement | null>;
  historyFocus: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <>
      {memory.files.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              ref={filesFocus}
              variant="outline"
              size="sm"
              className="ml-auto"
              data-memory-files
              aria-label={`Files, ${memory.files.length}`}
              onMouseEnter={() => {
                model.prefetchFiles();
                void loadFiles();
              }}
              onFocus={() => {
                model.prefetchFiles();
                void loadFiles();
              }}
              onClick={model.openFiles}
            >
              <Paperclip />
              <span aria-hidden className="lg:hidden">
                Files
              </span>
              <span aria-hidden className="tabular-nums">
                {memory.files.length}
              </span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Files</TooltipContent>
        </Tooltip>
      )}
      <Button
        ref={historyFocus}
        variant="outline"
        size="sm"
        className={memory.files.length > 0 ? undefined : 'ml-auto'}
        data-memory-history
        onMouseEnter={() => {
          model.prefetchHistory();
          void loadHistory();
        }}
        onFocus={() => {
          model.prefetchHistory();
          void loadHistory();
        }}
        onClick={model.openHistory}
      >
        <History /> History{' '}
        <span>
          {memory.version} {memory.version === 1 ? 'version' : 'versions'}
        </span>
      </Button>
      <MemoryActions
        pane
        subject={{
          id: memory.id,
          bucket: memory.bucket,
          title: memoryTitle(memory.content),
          version: memory.version,
        }}
        model={model}
      />
    </>
  );
}
function MemoryFiles({
  model,
  memory,
  returnFocus,
}: {
  model: MemoryPageModel;
  memory: OwnerMemory;
  returnFocus: RefObject<HTMLButtonElement | null>;
}) {
  // Keep an active download alive across dismissal; load the sheet only once used.
  const [opened, setOpened] = useState(model.filesOpen);
  if (model.filesOpen && !opened) setOpened(true);
  if (!opened) return null;
  return (
    <Suspense fallback={null}>
      <FilesSheet model={model} memory={memory} returnFocus={returnFocus} />
    </Suspense>
  );
}
function ReadingPane({ model }: { model: MemoryPageModel }) {
  const returnFocus = useRef<HTMLButtonElement>(null);
  const filesFocus = useRef<HTMLButtonElement>(null);
  const memory = model.selected;
  if (!memory)
    return (
      <div data-memory-reading className="flex min-w-0 flex-col">
        <MemoryBack model={model} />
        <ReadingState model={model} />
      </div>
    );
  return (
    <article aria-label="Memory detail" data-memory-reading className="min-w-0">
      <MemoryBack model={model} />
      <div className="px-5 pt-6 pb-16 lg:px-8 lg:pt-7">
        <ForgetProblem model={model} id={memory.id} pane />
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline" className="max-w-full whitespace-normal">
            <span className="max-w-full font-mono wrap-anywhere">
              {memory.bucket}
            </span>
          </Badge>
          <span>
            {memory.bucket === model.bucket
              ? 'Stored here'
              : 'Inherited memory'}
          </span>
          <ReadingActions
            model={model}
            memory={memory}
            filesFocus={filesFocus}
            historyFocus={returnFocus}
          />
        </div>
        <h2 className="max-w-3xl text-2xl font-semibold tracking-tight wrap-anywhere">
          {memoryTitle(memory.content)}
        </h2>
        <Provenance
          provenance={memory.provenance}
          label={memory.version > 1 ? 'Updated' : 'Stored'}
        />
        {memory.tags.length > 0 && (
          <div data-memory-tags className="mt-4 flex flex-wrap gap-1.5">
            {memory.tags.map((tag) => (
              <Badge variant="secondary" key={tag}>
                {tag}
              </Badge>
            ))}
          </div>
        )}
        <div className="mt-7">
          <MemoryMarkdown content={memory.content} />
        </div>
      </div>
      <MemoryFiles
        key={memory.id}
        model={model}
        memory={memory}
        returnFocus={filesFocus}
      />
      {model.historyOpen && (
        <Suspense fallback={null}>
          <HistorySheet
            key={memory.id}
            model={model}
            memory={memory}
            returnFocus={returnFocus}
          />
        </Suspense>
      )}
    </article>
  );
}
function PhoneBucketsLink({ model }: { model: MemoryPageModel }) {
  return (
    <div className={cn('mt-6 lg:hidden', model.detailOpen && 'hidden')}>
      <Button asChild variant="ghost" size="sm">
        <Link
          to="/memory"
          search={
            model.browse
              ? memorySearch(model)
              : memorySearch({ scope: model.scope, q: model.q })
          }
        >
          {model.browse ? (
            <>
              <ArrowLeft />
              {model.bucket}
            </>
          ) : (
            <>
              All buckets
              <ChevronRight />
            </>
          )}
        </Link>
      </Button>
    </div>
  );
}
export function MemoryPage() {
  const model = useMemoryPage();
  return (
    <div className="w-full min-w-0 px-4 pb-24 sm:px-6 md:px-10">
      <div className="pt-6 md:pt-8">
        <h1 className="text-xl font-semibold tracking-tight">Memory</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Read what agents stored in a bucket and the buckets above it.
        </p>
      </div>
      <PhoneBucketsLink model={model} />
      <div
        data-memory-layout
        className="mt-4 overflow-hidden rounded-lg border lg:mt-7"
      >
        <div
          data-memory-bucket-column
          className={cn('min-w-0', !model.browse && 'max-lg:hidden')}
        >
          <BucketNav model={model} />
        </div>
        <MemoryList model={model} />
        <div
          className={cn(
            'min-w-0',
            !model.detailOpen && 'max-lg:hidden',
            model.browse && 'max-lg:hidden',
          )}
        >
          <ReadingPane model={model} />
        </div>
      </div>
      <ForgetDialog model={model} />
    </div>
  );
}
