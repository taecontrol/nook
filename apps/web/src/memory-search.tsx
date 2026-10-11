import type { OwnerMemorySearchResult } from '@nook/contract';
import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { Search, SearchX, ServerCrash, TriangleAlert, X } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';
import { Item, ItemContent, ItemTitle } from '@/components/ui/item';
import { Kbd } from '@/components/ui/kbd';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';

import { formatDateTime, recentTime } from './time';
import type { MemoryPageModel } from './use-memory-page';

const inputId = 'memory-search-input';
const focusInput = () => document.getElementById(inputId)?.focus();
function typingTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}
function useSlashShortcut(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (
        event.key !== '/' ||
        event.metaKey ||
        event.ctrlKey ||
        typingTarget(event.target)
      )
        return;
      event.preventDefault();
      focusInput();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enabled]);
}
function fieldKey(
  event: KeyboardEvent<HTMLInputElement>,
  model: MemoryPageModel,
) {
  if (event.key === 'Escape') model.draft.clear();
  if (event.key === 'Enter') model.draft.submit();
  if (event.key === 'ArrowDown') {
    const first = document.querySelector<HTMLElement>('[data-search-result]');
    if (first) {
      event.preventDefault();
      first.focus();
    }
  }
}
export function SearchField({ model }: { model: MemoryPageModel }) {
  const disabled = model.firstRun;
  useSlashShortcut(!disabled);
  return (
    <search className="mt-3 block">
      <InputGroup data-disabled={disabled ? 'true' : undefined}>
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput
          id={inputId}
          value={model.draft.draft}
          onChange={(event) => model.draft.setDraft(event.target.value)}
          onKeyDown={(event) => fieldKey(event, model)}
          disabled={disabled}
          placeholder={
            disabled ? 'No memories to search yet' : 'Search memories'
          }
          aria-label={`Search memories visible in ${model.bucket}`}
          aria-controls="memory-results"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          maxLength={512}
        />
        <InputGroupAddon align="inline-end">
          {model.searching && model.results.isFetching && <Spinner />}
          {model.draft.draft ? (
            <InputGroupButton
              size="icon-xs"
              aria-label="Clear search"
              onClick={() => {
                model.draft.clear();
                focusInput();
              }}
            >
              <X />
            </InputGroupButton>
          ) : (
            !disabled && (
              <Kbd className="max-lg:hidden" aria-label="Press slash to search">
                /
              </Kbd>
            )
          )}
        </InputGroupAddon>
      </InputGroup>
    </search>
  );
}
function listSummary(model: MemoryPageModel) {
  if (model.list.isPending) return 'Loading memories…';
  if (model.list.isError) return 'Memories unavailable';
  const n = model.total ?? model.records.length;
  return `${n} ${n === 1 ? 'memory' : 'memories'}${model.total === null ? ' loaded' : ''} · newest first`;
}
function searchSummary(model: MemoryPageModel) {
  if (model.results.isError && !model.results.isFetching)
    return 'Search failed';
  if (!model.results.data || model.results.isFetching) return 'Searching…';
  const n = model.results.data.results.length;
  if (!n) return 'No results';
  return `${n} ${n === 1 ? 'result' : 'results'} · ${model.results.data.meaning === 'unavailable' ? 'exact words only' : 'best match first'}`;
}
export function ColumnSummary({ model }: { model: MemoryPageModel }) {
  return (
    <div
      aria-live="polite"
      className="flex h-9 items-center justify-between gap-3 border-b px-4 text-xs text-muted-foreground"
    >
      <span className="min-w-0 truncate">
        {model.searching ? searchSummary(model) : listSummary(model)}
      </span>
      {model.searching && (
        <span className="flex shrink-0 items-center gap-1 max-lg:hidden">
          <Kbd>Esc</Kbd> clears
        </span>
      )}
    </div>
  );
}
function Snippet({ result }: { result: OwnerMemorySearchResult }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of result.highlights) {
    parts.push(
      result.snippet.slice(at, start),
      <mark key={`${start}-${end}`}>{result.snippet.slice(start, end)}</mark>,
    );
    at = end;
  }
  parts.push(result.snippet.slice(at));
  return (
    <p
      data-search-snippet
      className="line-clamp-3 text-xs leading-5 text-muted-foreground wrap-anywhere"
    >
      {parts}
    </p>
  );
}
function resultKey(
  event: KeyboardEvent<HTMLAnchorElement>,
  model: MemoryPageModel,
) {
  if (event.key === 'Escape') {
    model.draft.clear();
    focusInput();
    return;
  }
  if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  const rows = [
    ...document.querySelectorAll<HTMLAnchorElement>('[data-search-result]'),
  ];
  const index = rows.indexOf(event.currentTarget);
  const next = index + (event.key === 'ArrowDown' ? 1 : -1);
  if (next < 0) focusInput();
  else rows[Math.min(next, rows.length - 1)]?.focus();
}
function bucketLabel(bucket: string) {
  const slash = bucket.lastIndexOf('/');
  return bucket.length > 22 && slash > 0
    ? `…/${bucket.slice(slash + 1)}`
    : bucket;
}
function SearchRow({
  result,
  model,
}: {
  result: OwnerMemorySearchResult;
  model: MemoryPageModel;
}) {
  const selected = model.search.memory === result.id;
  return (
    <li className={cn('border-b', selected && 'bg-accent')}>
      <Item asChild size="sm" className="w-full min-w-0">
        <Link
          to="/memory"
          search={{
            bucket: model.bucket,
            scope: model.scope,
            q: model.q,
            memory: result.id,
          }}
          data-search-result={result.id}
          aria-current={selected ? 'true' : undefined}
          title={result.title}
          onMouseEnter={() => model.prefetch(result.id)}
          onFocus={() => model.prefetch(result.id)}
          onKeyDown={(event) => resultKey(event, model)}
        >
          <ItemContent className="min-w-0">
            <ItemTitle className="block min-w-0 max-w-full">
              <span className="line-clamp-2 wrap-anywhere">{result.title}</span>
            </ItemTitle>
            <Snippet result={result} />
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <span
                title={result.bucket}
                className={cn(
                  'max-w-36 truncate font-mono',
                  result.bucket !== model.bucket &&
                    'font-semibold text-foreground',
                )}
              >
                {bucketLabel(result.bucket)}
              </span>
              <span aria-hidden>·</span>
              <span
                className="shrink-0 tabular-nums"
                title={formatDateTime(result.createdAt)}
              >
                {recentTime(result.createdAt)}
              </span>
              {result.match === 'meaning' && (
                <Badge variant="outline" className="ml-auto shrink-0">
                  By meaning
                </Badge>
              )}
            </div>
          </ItemContent>
        </Link>
      </Item>
    </li>
  );
}
function SearchSkeleton() {
  return (
    <div role="status" aria-label="Searching memories" className="divide-y">
      {['a', 'b', 'c', 'd'].map((id) => (
        <div key={id} className="space-y-3 px-4 py-4">
          <Skeleton className="h-4 w-3/5" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-3 w-2/5" />
        </div>
      ))}
    </div>
  );
}
function SearchError({ model }: { model: MemoryPageModel }) {
  return (
    <div className="px-5 py-12">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ServerCrash />
          </EmptyMedia>
          <EmptyTitle>Could not search memories</EmptyTitle>
          <EmptyDescription>
            Your query is still here. Try searching again.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void model.results.refetch()}
          >
            Try again
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}
function MeaningUnavailable({ model }: { model: MemoryPageModel }) {
  return (
    <div className="p-3">
      <Alert>
        <TriangleAlert />
        <AlertTitle>Exact words only</AlertTitle>
        <AlertDescription>
          Meaning search is unavailable. Reworded or other-language memories may
          be missing.
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void model.results.refetch()}
          >
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
}
function NoResults({ model }: { model: MemoryPageModel }) {
  return (
    <div className="px-5 py-12">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchX />
          </EmptyMedia>
          <EmptyTitle>No memories found</EmptyTitle>
          <EmptyDescription>
            Try another query in {model.bucket}
            {model.scope === 'inherited' ? ' or the buckets above it' : ''}.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          {model.scope === 'bucket' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => model.changeScope('inherited')}
            >
              Include inherited
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              model.draft.clear();
              focusInput();
            }}
          >
            Clear search
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}
export function SearchBody({ model }: { model: MemoryPageModel }) {
  if (model.results.isError) return <SearchError model={model} />;
  if (!model.results.data) return <SearchSkeleton />;
  return (
    <div
      id="memory-results"
      data-search-results
      aria-busy={model.results.isFetching}
      className={cn(model.results.isFetching && 'opacity-50')}
    >
      {model.results.data.meaning === 'unavailable' && (
        <MeaningUnavailable model={model} />
      )}
      {model.results.data.results.length ? (
        <ul>
          {model.results.data.results.map((result) => (
            <SearchRow key={result.id} result={result} model={model} />
          ))}
        </ul>
      ) : (
        <NoResults model={model} />
      )}
    </div>
  );
}
