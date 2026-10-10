import { type Memory, type MemoryListItem, memoryTitle } from '@nook/contract';
import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { ArrowLeft, BookOpen, ChevronRight, ServerCrash } from 'lucide-react';
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
import { ApiError } from './api-client';
import { MemoryMarkdown } from './memory-markdown';
import { type MemoryPageModel, useMemoryPage } from './use-memory-page';
import { BucketTree, BucketTreeSkeleton } from './vault-tree';
import './memory.css';

function principalName(memory: Memory | MemoryListItem) {
  return memory.provenance.principal.kind === 'owner'
    ? 'Owner'
    : memory.provenance.principal.name;
}
function relativeTime(value: string) {
  const hours = Math.max(
    1,
    Math.floor((Date.now() - Date.parse(value)) / 3_600_000),
  );
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}
const absoluteTime = (value: string) =>
  `${new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value))} UTC`;
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
          <Button
            variant="outline"
            size="sm"
            onClick={() => void model.buckets.refetch()}
          >
            Retry buckets
          </Button>
        ) : (
          <BucketTree
            buckets={model.buckets.data.map((row) => row.path)}
            selected={model.browse ? null : model.bucket}
            counts={model.counts}
            loading={model.countsQuery.isPending}
            to="/memory"
            noun="memory"
            scope={model.scope}
          />
        )}
      </div>
      {model.countsQuery.isError && (
        <div className="pb-3 text-xs text-muted-foreground">
          <p>Could not load memory counts</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void model.countsQuery.refetch()}
          >
            Retry counts
          </Button>
        </div>
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
      <Item asChild size="sm" className="w-full min-w-0">
        <Link
          to="/memory"
          search={{
            bucket: model.bucket,
            scope: model.scope,
            memory: memory.id,
          }}
          data-memory-row={memory.id}
          data-inherited={inherited ? 'true' : undefined}
          title={memory.title}
          aria-current={selected ? 'true' : undefined}
          onMouseEnter={() => model.prefetch(memory.id)}
          onFocus={() => model.prefetch(memory.id)}
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
                title={absoluteTime(memory.createdAt)}
              >
                {relativeTime(memory.createdAt)}
              </span>
              <span aria-hidden>·</span>
              <span className="min-w-0 truncate">{principalName(memory)}</span>
            </div>
          </ItemContent>
        </Link>
      </Item>
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
function EmptyList({ model }: { model: MemoryPageModel }) {
  return (
    <div className="px-5 py-16">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BookOpen />
          </EmptyMedia>
          <EmptyTitle>No memories yet</EmptyTitle>
          <EmptyDescription>
            {model.firstRun ? (
              <>
                <span>Agents have not stored any memories yet.</span> Use MCP{' '}
                <code>remember</code> to store one in a bucket.
              </>
            ) : model.scope === 'bucket' ? (
              `There are no memories stored in ${model.bucket}. Include inherited to see memories from its ancestors.`
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
      <div className="px-5 py-12 text-center">
        <ServerCrash className="mx-auto mb-3 size-6 text-muted-foreground" />
        <h3 className="font-medium">Could not load memories</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Try loading this bucket again.
        </p>
        <div className="mt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void model.list.refetch();
              if (model.countsQuery.isError) void model.countsQuery.refetch();
              if (model.detail.isError) void model.detail.refetch();
            }}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  if (!model.records.length) return <EmptyList model={model} />;
  return (
    <>
      <div className="border-b px-4 py-2 text-xs text-muted-foreground">
        {model.total === null
          ? `${model.records.length} memories loaded`
          : `${model.total} memories`}{' '}
        · newest first
      </div>
      <ul>
        {model.records.map((memory) => (
          <MemoryRow key={memory.id} memory={memory} model={model} />
        ))}
      </ul>
      {model.list.hasNextPage && (
        <div className="p-3 text-center">
          <Button
            variant="outline"
            size="sm"
            disabled={model.list.isFetchingNextPage}
            onClick={() => void model.list.fetchNextPage()}
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
        <div className="font-mono text-sm font-semibold wrap-anywhere">
          {model.bucket}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {model.scope === 'inherited'
            ? 'Memories here and from ancestors'
            : 'Memories stored in this bucket'}
        </p>
        <fieldset className="mt-3 flex gap-1" aria-label="Memory scope">
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
      <ListBody model={model} />
    </section>
  );
}
function Provenance({ memory }: { memory: Memory }) {
  const { client, workingDirectory, at } = memory.provenance;
  return (
    <dl className="mt-5 grid gap-x-7 gap-y-3 border-y py-4 text-xs sm:grid-cols-2">
      <div>
        <dt className="text-muted-foreground">Written by</dt>
        <dd className="mt-0.5 font-medium wrap-anywhere">
          {principalName(memory)}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">
          Client <span>(as reported)</span>
        </dt>
        <dd className="mt-0.5 font-medium wrap-anywhere">
          {client.name}
          {client.version ? ` ${client.version}` : ''}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Stored</dt>
        <dd>
          <time dateTime={at} className="mt-0.5 block font-medium">
            {absoluteTime(at)}
          </time>
        </dd>
      </div>
      {workingDirectory && (
        <div className="min-w-0">
          <dt className="text-muted-foreground">Working directory</dt>
          <dd
            title={workingDirectory}
            className="mt-0.5 break-all font-mono font-medium"
          >
            {workingDirectory}
          </dd>
        </div>
      )}
    </dl>
  );
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
      <div className="px-8 py-12">
        <p>Could not load memory</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void model.detail.refetch()}
        >
          Retry memory
        </Button>
      </div>
    );
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
          <EmptyTitle>Choose a memory</EmptyTitle>
          <EmptyDescription>
            Select a memory to read its full content and see who stored it.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </section>
  );
}
function MemoryBack({ model }: { model: MemoryPageModel }) {
  return (
    <div className="sticky top-0 z-10 border-b bg-background px-5 py-3 lg:hidden">
      <Button asChild variant="ghost" size="sm">
        <Link
          to="/memory"
          search={{ bucket: model.bucket, scope: model.scope }}
        >
          <ArrowLeft />
          Memories
        </Link>
      </Button>
    </div>
  );
}
function ReadingPane({ model }: { model: MemoryPageModel }) {
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
        </div>
        <h2 className="max-w-3xl text-2xl font-semibold tracking-tight wrap-anywhere">
          {memoryTitle(memory.content)}
        </h2>
        <Provenance memory={memory} />
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
    </article>
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
      <div className={cn('mt-6 lg:hidden', model.detailOpen && 'hidden')}>
        <Button asChild variant="ghost" size="sm">
          <Link
            to="/memory"
            search={
              model.browse
                ? { bucket: model.bucket, scope: model.scope }
                : { scope: model.scope }
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
    </div>
  );
}
