import type { AuditEntry } from '@nook/contract';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { cn } from 'cn';
import {
  ArrowDown,
  ChevronRight,
  CircleCheck,
  Eye,
  History,
  SearchX,
  ServerCrash,
  ShieldX,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Item } from '@/components/ui/item';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { type AuditFilters, auditOptions } from './audit-api';
import { useBucketList } from './buckets-api';
import { useMachineList } from './machines-api';
import { useSecretList } from './vault-api';

const allBuckets = '*';

function recentTime(at: string) {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(at)) / 60_000),
  );
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return new Date(at).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(new Date(at).getFullYear() !== new Date().getFullYear()
      ? { year: 'numeric' as const }
      : {}),
  });
}
function exactTime(at: string) {
  return new Date(at).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'long',
  });
}
function inBucket(path: string, bucket?: string) {
  return !bucket || path.startsWith(`${bucket}/`);
}

function filterPaths(
  current: readonly { path: string }[] | undefined,
  historical: string[],
  selected?: string,
) {
  return [
    ...new Set([
      ...(current ?? []).map((item) => item.path),
      ...historical,
      ...(selected ? [selected] : []),
    ]),
  ].sort();
}
function missingFrom<T>(
  items: readonly T[] | undefined,
  matches: (item: T) => boolean,
) {
  return items !== undefined && !items.some(matches);
}

function Filters({
  filters,
  entries,
  buckets,
  secrets,
}: {
  filters: AuditFilters;
  entries: AuditEntry[];
  buckets?: readonly { path: string }[];
  secrets?: readonly { path: string }[];
}) {
  const queries = useQueryClient();
  const navigate = useNavigate({ from: '/audit' });
  const bucketPaths = filterPaths(
    buckets,
    entries.map((entry) => entry.bucket),
    filters.bucket,
  );
  const secretPaths = filterPaths(
    secrets,
    entries.map((entry) => entry.path),
    filters.secret,
  ).filter((path) => path === filters.secret || inBucket(path, filters.bucket));
  const changeBucket = (value: string): AuditFilters => {
    const bucket = value === allBuckets ? undefined : value;
    return {
      bucket,
      secret:
        filters.secret && inBucket(filters.secret, bucket)
          ? filters.secret
          : undefined,
    };
  };
  const changeSecret = (value: string): AuditFilters => ({
    ...filters,
    secret: value === 'all' ? undefined : value,
  });
  const preload = (next: AuditFilters) =>
    void queries.prefetchInfiniteQuery(auditOptions(next));
  return (
    <div className="sticky top-16 z-10 mb-4 border-b bg-background py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:max-w-64">
          <Label htmlFor="audit-bucket">Bucket</Label>
          <Select
            value={filters.bucket ?? allBuckets}
            onValueChange={(value) =>
              void navigate({ search: changeBucket(value) })
            }
          >
            <SelectTrigger id="audit-bucket" className="w-full min-w-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" className="w-80 sm:w-96">
              <SelectItem
                value={allBuckets}
                onPointerEnter={() => preload(changeBucket(allBuckets))}
              >
                All buckets
              </SelectItem>
              {bucketPaths.map((path) => (
                <SelectItem
                  key={path}
                  value={path}
                  className="w-72 sm:w-80"
                  onPointerEnter={() => preload(changeBucket(path))}
                >
                  <span className="min-w-0 font-mono text-xs break-all">
                    {path}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:max-w-96">
          <Label htmlFor="audit-secret">Secret</Label>
          <Select
            value={filters.secret ?? 'all'}
            onValueChange={(value) =>
              void navigate({ search: changeSecret(value) })
            }
          >
            <SelectTrigger id="audit-secret" className="w-full min-w-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" className="w-80 sm:w-96">
              <SelectItem
                value="all"
                onPointerEnter={() => preload(changeSecret('all'))}
              >
                All secrets
              </SelectItem>
              {secretPaths.map((path) => (
                <SelectItem
                  key={path}
                  value={path}
                  className="w-72 sm:w-80"
                  onPointerEnter={() => preload(changeSecret(path))}
                >
                  <span className="min-w-0 font-mono text-xs break-all">
                    {path}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {(filters.bucket || filters.secret) && (
          <Button variant="ghost" size="sm" asChild>
            <Link to="/audit" search={{}}>
              Clear filters
            </Link>
          </Button>
        )}
      </div>
      {filters.bucket && (
        <p className="mt-2 text-xs text-muted-foreground">
          Includes buckets inside{' '}
          <span className="font-mono wrap-anywhere">{filters.bucket}</span>.
        </p>
      )}
    </div>
  );
}

function Outcome({ entry }: { entry: AuditEntry }) {
  return entry.outcome === 'denied' ? (
    <Badge variant="destructive">
      <ShieldX />
      Denied
    </Badge>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      {entry.outcome === 'revealed' ? (
        <Eye className="size-3" aria-hidden />
      ) : (
        <CircleCheck className="size-3" aria-hidden />
      )}
      {entry.outcome === 'revealed'
        ? 'Revealed'
        : entry.outcome === 'created'
          ? 'Created'
          : 'Delivered'}
    </span>
  );
}
function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="mb-1 text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm wrap-anywhere">{children}</dd>
    </div>
  );
}
function entrySource(entry: AuditEntry) {
  if (entry.outcome === 'revealed')
    return {
      name: 'Web app',
      detail: `${entry.ip ?? 'Unknown'} · ${entry.country ?? 'Unknown'}`,
    };
  return {
    name: entry.machine.name,
    detail: entry.outcome === 'created' ? '' : entry.executable,
  };
}
function Entry({
  entry,
  revoked,
  deleted,
}: {
  entry: AuditEntry;
  revoked: boolean;
  deleted: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { name: machineName, detail: executable } = entrySource(entry);
  return (
    <li
      data-entry={entry.id}
      className={cn(
        'min-w-0',
        entry.outcome === 'denied' && 'bg-destructive/5',
      )}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <Item size="sm" className="flex-nowrap items-start lg:items-center">
          <div className="hidden w-20 shrink-0 text-xs tabular-nums text-muted-foreground lg:block">
            <time dateTime={entry.at} title={exactTime(entry.at)}>
              {recentTime(entry.at)}
            </time>
          </div>
          <div className="hidden w-24 shrink-0 lg:block">
            <Outcome entry={entry} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1 lg:flex-row lg:items-center lg:gap-4">
            <div className="flex items-center justify-between gap-2 lg:hidden">
              <Outcome entry={entry} />
              <time
                className="text-xs tabular-nums text-muted-foreground"
                dateTime={entry.at}
              >
                {recentTime(entry.at)}
              </time>
            </div>
            <div className="min-w-0 flex-1">
              <div
                className="truncate font-mono text-sm font-medium"
                title={entry.name}
              >
                {entry.name}
              </div>
              <div
                className="truncate font-mono text-xs text-muted-foreground"
                title={entry.bucket}
              >
                {entry.bucket}
              </div>
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm" title={entry.purpose}>
                {entry.purpose}
              </p>
              <p className="mt-1 truncate text-xs text-muted-foreground lg:hidden">
                {machineName}
                {executable && ` · ${executable}`}
              </p>
            </div>
            <div className="hidden w-40 min-w-0 shrink-0 lg:block">
              <p className="truncate text-sm" title={machineName}>
                {machineName}
              </p>
              <p
                className="truncate font-mono text-xs text-muted-foreground"
                title={executable}
              >
                {executable}
              </p>
            </div>
          </div>
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`${open ? 'Hide' : 'Show'} details for ${entry.path}, ${recentTime(entry.at)}`}
            >
              <ChevronRight
                className={cn('transition-transform', open && 'rotate-90')}
              />
            </Button>
          </CollapsibleTrigger>
        </Item>
        <CollapsibleContent>
          <EntryDetails entry={entry} revoked={revoked} deleted={deleted} />
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
const regions = new Intl.DisplayNames('en', {
  type: 'region',
  fallback: 'code',
});
function countryName(country: string | null) {
  if (!country) return 'Unknown';
  try {
    return regions.of(country) ?? country;
  } catch {
    return country;
  }
}
function EntryDetails({
  entry,
  revoked,
  deleted,
}: {
  entry: AuditEntry;
  revoked: boolean;
  deleted: boolean;
}) {
  return (
    <div className="border-t bg-muted/30 px-4 py-4 lg:px-6">
      {entry.outcome === 'denied' && (
        <p className="mb-4 flex items-start gap-2 text-sm text-destructive">
          <ShieldX className="mt-0.5 size-4 shrink-0" />
          Outside this machine’s bucket grant. No value was delivered.
        </p>
      )}
      <dl className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Fact label="Secret">
          <span className="font-mono">{entry.path}</span>
          {deleted && (
            <div className="mt-1">
              <Badge variant="outline">Deleted</Badge>
            </div>
          )}
        </Fact>
        <Fact label="Recorded">
          <time dateTime={entry.at}>{exactTime(entry.at)}</time>
        </Fact>
        {entry.outcome === 'revealed' ? (
          <>
            <Fact label="Source">Web app</Fact>
            <div className="min-w-0 sm:col-span-2 lg:col-span-3">
              <Fact label="Purpose">{entry.purpose}</Fact>
            </div>
            <Fact label="IP address">
              <span className="font-mono">{entry.ip ?? 'Unknown'}</span>
            </Fact>
            <Fact label="Country">{countryName(entry.country)}</Fact>
          </>
        ) : (
          <>
            <Fact label="Machine">
              {entry.machine.name}
              {revoked && (
                <div className="mt-1">
                  <Badge variant="outline">Revoked</Badge>
                </div>
              )}
            </Fact>
            <div className="min-w-0 sm:col-span-2 lg:col-span-3">
              <Fact label="Purpose">{entry.purpose}</Fact>
            </div>
            <div className="min-w-0 sm:col-span-2">
              <Fact label="Working directory">
                <span className="font-mono">{entry.workingDirectory}</span>
              </Fact>
            </div>
            {entry.outcome !== 'created' && (
              <>
                <Fact label="Executable">
                  <span className="font-mono">{entry.executable}</span>
                </Fact>
                <Fact label="Run">
                  <span className="font-mono text-xs">{entry.runId}</span>
                </Fact>
              </>
            )}
          </>
        )}
      </dl>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" asChild>
          <Link to="/audit" search={{ secret: entry.path }}>
            Activity for this secret
          </Link>
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <Link to="/audit" search={{ bucket: entry.bucket }}>
            Activity in this bucket
          </Link>
        </Button>
      </div>
    </div>
  );
}
function Loading() {
  return (
    <div
      role="status"
      aria-label="Loading audit entries"
      aria-busy="true"
      className="divide-y rounded-lg border"
    >
      {['a', 'b', 'c', 'd', 'e', 'f'].map((id) => (
        <div key={id} className="flex items-center gap-4 p-4">
          <Skeleton className="hidden h-4 w-20 sm:block" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56 max-w-full" />
          </div>
          <Skeleton className="size-8" />
        </div>
      ))}
    </div>
  );
}
function NoEntries({ filtered }: { filtered: boolean }) {
  return (
    <div className="rounded-lg border border-dashed">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            {filtered ? <SearchX /> : <History />}
          </EmptyMedia>
          <EmptyTitle>
            {filtered
              ? 'No activity matches these filters'
              : 'No secret activity yet'}
          </EmptyTitle>
          <EmptyDescription>
            {filtered
              ? 'Try another bucket or secret, or return to all activity.'
              : 'When a machine uses a secret through nook run or stores one through nook vault create, or you reveal a value in the web app, it appears here. Denied uses appear here too.'}
          </EmptyDescription>
        </EmptyHeader>
        {filtered && (
          <EmptyContent>
            <Button variant="outline" size="sm" asChild>
              <Link to="/audit" search={{}}>
                Clear filters
              </Link>
            </Button>
          </EmptyContent>
        )}
      </Empty>
    </div>
  );
}
export function AuditPage() {
  const filters = useSearch({ from: '/owner/audit' });
  const query = useAuditEntries(filters);
  const machines = useMachineList();
  const secrets = useSecretList();
  const buckets = useBucketList();
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  const entries = query.data?.pages.flatMap((page) => page.entries) ?? [];
  return (
    <div className="w-full max-w-7xl px-4 pb-24 sm:px-6 md:px-12">
      <h1 className="pt-6 pb-2 text-xl font-semibold tracking-tight md:pt-8">
        Audit
      </h1>
      <p className="max-w-2xl text-sm text-muted-foreground">
        Every secret use, creation, and reveal, newest first. Review what
        happened, why, and by which machine.
      </p>
      <Filters
        filters={filters}
        entries={entries}
        buckets={buckets.data}
        secrets={secrets.data}
      />
      <AuditResults
        query={query}
        entries={entries}
        filtered={Boolean(filters.bucket || filters.secret)}
        machines={machines.data}
        secrets={secrets.data}
      />
    </div>
  );
}

function useAuditEntries(filters: AuditFilters) {
  return useInfiniteQuery(
    auditOptions({ bucket: filters.bucket, secret: filters.secret }),
  );
}
function AuditLoadFailure({
  query,
}: {
  query: ReturnType<typeof useAuditEntries>;
}) {
  if (!query.isError) return null;
  const retry = (
    <Button
      variant="outline"
      size="sm"
      disabled={query.isFetching}
      onClick={() =>
        void (query.isFetchNextPageError
          ? query.fetchNextPage()
          : query.refetch())
      }
    >
      Try again
    </Button>
  );
  if (query.data)
    return (
      <Alert variant="destructive" className="mb-4">
        <ServerCrash />
        <AlertTitle>
          {query.isFetchNextPageError
            ? 'Couldn’t load more entries'
            : 'Couldn’t refresh audit entries'}
        </AlertTitle>
        <AlertDescription>
          Showing the last loaded activity. {query.error.message}
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
          <EmptyTitle>Couldn’t load audit entries</EmptyTitle>
          <EmptyDescription>
            {query.error.message} Try again in a moment.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>{retry}</EmptyContent>
      </Empty>
    </div>
  );
}
function AuditResults({
  query,
  entries,
  filtered,
  machines,
  secrets,
}: {
  query: ReturnType<typeof useAuditEntries>;
  entries: AuditEntry[];
  filtered: boolean;
  machines?: readonly { id: string }[];
  secrets?: readonly { path: string }[];
}) {
  return query.isPending ? (
    <Loading />
  ) : !query.data ? (
    <AuditLoadFailure query={query} />
  ) : (
    <>
      <AuditLoadFailure query={query} />
      {entries.length === 0 ? (
        <NoEntries filtered={filtered} />
      ) : (
        <section aria-label="Secret activity">
          <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>{entries.length} entries loaded</span>
            <span>Newest first</span>
          </div>
          <div className="hidden items-center gap-2.5 border-b px-4 py-2 text-xs text-muted-foreground lg:flex">
            <span className="w-20 shrink-0">When</span>
            <span className="w-24 shrink-0">Outcome</span>
            <div className="flex flex-1 gap-4">
              <span className="flex-1">Secret / bucket</span>
              <span className="flex-1">Purpose</span>
              <span className="w-40 shrink-0">Machine / executable</span>
            </div>
            <span className="w-8" />
          </div>
          <ul className="divide-y rounded-lg border">
            {entries.map((entry) => (
              <Entry
                key={entry.id}
                entry={entry}
                revoked={
                  entry.outcome !== 'revealed' &&
                  missingFrom(
                    machines,
                    (machine) => machine.id === entry.machine.id,
                  )
                }
                deleted={missingFrom(
                  secrets,
                  (secret) => secret.path === entry.path,
                )}
              />
            ))}
          </ul>
          <div className="mt-4 flex flex-col items-center gap-2">
            {query.hasNextPage ? (
              <Button
                variant="outline"
                size="sm"
                disabled={query.isFetching}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? <Spinner /> : <ArrowDown />}Load
                older entries
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                You’ve reached the first entry.
              </p>
            )}
          </div>
        </section>
      )}
    </>
  );
}
