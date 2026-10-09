import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import {
  ChevronLeft,
  Eye,
  KeyRound,
  MoreHorizontal,
  Plus,
  Replace,
  SearchX,
  ServerCrash,
  Trash2,
} from 'lucide-react';
import { lazy, Suspense, useRef } from 'react';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  ItemTitle,
} from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { ApiError } from './api-client';
import { formatDate, RESERVED } from './paths';
import { useVaultPage } from './use-vault-page';
import { WriteFeedback } from './vault-feedback';
import {
  ancestorsOf,
  plural,
  type Secret,
  secretPath,
  secretsIn,
} from './vault-model';
import { reachText, SecretSheet } from './vault-sheet';

import { BucketTree, BucketTreeSkeleton } from './vault-tree';

const RevealDialog = lazy(() => import('./reveal-dialog'));

const sectionLabel =
  'text-xs font-medium tracking-wider text-muted-foreground uppercase';

function Path({ children }: { children: string }) {
  return <span className="font-mono wrap-anywhere">{children}</span>;
}

/** "work and me", each path in mono. */
function Paths({ paths }: { paths: readonly string[] }) {
  return paths.map((path, index) => (
    <span key={path}>
      {index > 0 && (index === paths.length - 1 ? ' and ' : ', ')}
      <Path>{path}</Path>
    </span>
  ));
}

/* ---------- secret rows ---------- */

function SecretMenu({
  secret,
  busy,
  onReveal,
  onReplace,
  onDelete,
}: {
  secret: Secret;
  busy: boolean;
  onReveal: (secret: Secret) => void;
  onReplace: (secret: Secret) => void;
  onDelete: (secret: Secret, trigger: HTMLButtonElement | null) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          ref={trigger}
          variant="ghost"
          size="icon-sm"
          aria-label={`Actions for ${secretPath(secret)}`}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex flex-col font-normal">
          <span className="font-mono text-xs wrap-anywhere">
            {secretPath(secret)}
          </span>
          <span className="text-xs text-muted-foreground">
            Updated {formatDate(secret.updatedAt)}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={busy} onSelect={() => onReveal(secret)}>
          <Eye />
          Reveal value…
        </DropdownMenuItem>
        <DropdownMenuItem disabled={busy} onSelect={() => onReplace(secret)}>
          <Replace />
          Replace value…
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          disabled={busy}
          onSelect={() => onDelete(secret, trigger.current)}
        >
          <Trash2 />
          Delete secret…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Updated({
  secret,
  saving,
  confirming,
}: {
  secret: Secret;
  saving: boolean;
  confirming: boolean;
}) {
  if (saving)
    return (
      <span className="inline-flex items-center gap-1.5">
        <Spinner className="size-3" />
        {confirming ? 'Confirming…' : 'Saving…'}
      </span>
    );
  return <>{formatDate(secret.updatedAt)}</>;
}

function SecretRow({
  secret,
  saving,
  highlighted,
  actions,
  confirming = false,
}: {
  secret: Secret;
  saving: boolean;
  highlighted: boolean;
  actions?: React.ReactNode;
  confirming?: boolean;
}) {
  return (
    <li
      data-secret={secretPath(secret)}
      className={cn('transition-colors', highlighted && 'bg-accent')}
    >
      <Item size="sm" className="flex-nowrap items-start sm:items-center">
        <ItemContent className="min-w-0">
          <ItemTitle className="w-full">
            <span className="font-mono wrap-anywhere">{secret.name}</span>
          </ItemTitle>
          {secret.description && (
            <ItemDescription truncate={false} className="wrap-break-word">
              {secret.description}
            </ItemDescription>
          )}
          <span className="text-xs text-muted-foreground sm:hidden">
            {saving ? (
              <Updated secret={secret} saving confirming={confirming} />
            ) : (
              <>Updated {formatDate(secret.updatedAt)}</>
            )}
          </span>
        </ItemContent>
        <div className="hidden w-28 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:block">
          <Updated secret={secret} saving={saving} confirming={confirming} />
        </div>
        <ItemActions className="w-8 shrink-0 justify-center">
          {actions}
        </ItemActions>
      </Item>
    </li>
  );
}

function ListHeader({
  id,
  title,
  count,
}: {
  id: string;
  title: string;
  count: number;
}) {
  return (
    <div className="mb-2 flex h-8 items-center gap-2 border-b pr-4">
      <h3 id={id} className={sectionLabel}>
        {title}
      </h3>
      <Badge variant="secondary">{count}</Badge>
      <span className="ml-auto hidden w-28 text-right text-xs text-muted-foreground sm:block">
        Updated
      </span>
      <span className="hidden w-8 sm:block" />
    </div>
  );
}

function SecretsSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading secrets">
      <div className="mb-2 flex h-8 items-center border-b">
        <Skeleton className="h-3 w-24" />
      </div>
      <ul className="divide-y rounded-lg border">
        {[
          { id: 'a', name: <Skeleton className="h-4 w-32" /> },
          { id: 'b', name: <Skeleton className="h-4 w-24" /> },
          { id: 'c', name: <Skeleton className="h-4 w-40" /> },
          { id: 'd', name: <Skeleton className="h-4 w-28" /> },
        ].map((row) => (
          <li key={row.id} className="flex items-center gap-3 px-4 py-3">
            <div className="flex flex-1 flex-col gap-2">
              {row.name}
              <Skeleton className="h-3.5 w-56 max-w-full" />
            </div>
            <Skeleton className="hidden h-3 w-20 sm:block" />
            <Skeleton className="size-8" />
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------- inherited secrets ---------- */

function Inherited({
  bucket,
  secrets,
}: {
  bucket: string;
  secrets: readonly Secret[];
}) {
  const ancestors = ancestorsOf(bucket);
  const groups = ancestors
    .map((ancestor) => ({
      bucket: ancestor,
      secrets: secretsIn(secrets, ancestor),
    }))
    .filter((group) => group.secrets.length > 0);
  if (ancestors.length === 0) return null;
  const total = groups.reduce((sum, group) => sum + group.secrets.length, 0);
  return (
    <section aria-labelledby="inherited-heading" className="mt-10">
      <div className="mb-3">
        <div className="flex h-8 items-center gap-2 border-b pr-4">
          <h3 id="inherited-heading" className={sectionLabel}>
            Inherited
          </h3>
          <Badge variant="secondary">{total}</Badge>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          {total === 0 ? (
            <>
              Agents working in <Path>{bucket}</Path> would also find secrets
              stored in <Paths paths={ancestors} />. There are none yet.
            </>
          ) : (
            <>
              Agents working in <Path>{bucket}</Path> also find these, from{' '}
              <Paths paths={groups.map((group) => group.bucket)} />. Open a
              bucket to change its secrets.
            </>
          )}
        </p>
      </div>
      <div className="flex flex-col gap-4">
        {groups.map((group) => (
          <div key={group.bucket}>
            <div className="mb-1.5 flex items-center gap-2">
              <Link
                to="/vault"
                search={{ bucket: group.bucket }}
                className="rounded-sm font-mono text-xs font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {group.bucket}
              </Link>
              <span className="text-xs text-muted-foreground">
                {plural(group.secrets.length, 'secret')}
              </span>
            </div>
            <ul className="divide-y overflow-hidden rounded-lg border bg-muted/30">
              {group.secrets.map((secret) => (
                <SecretRow
                  key={secret.name}
                  secret={secret}
                  saving={false}
                  highlighted={false}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ---------- empty and failure states ---------- */

function LoadFailure({
  status,
  retrying,
  onRetry,
  compact,
  cached = false,
  busy = false,
}: {
  status: number;
  retrying: boolean;
  onRetry: () => void;
  compact?: boolean;
  cached?: boolean;
  busy?: boolean;
}) {
  const retry = (
    <Button
      variant="outline"
      size="sm"
      disabled={retrying || busy}
      onClick={onRetry}
    >
      {retrying && <Spinner />}Try again
    </Button>
  );
  if (compact)
    return (
      <Alert variant="destructive" className="mb-4">
        <ServerCrash />
        <AlertTitle>Couldn’t load secrets</AlertTitle>
        <AlertDescription>
          Nook is unavailable right now ({status}).{' '}
          {cached
            ? 'Secret metadata could not be refreshed. Previously loaded data is still shown.'
            : 'Bucket counts are missing until it loads.'}
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
          <EmptyTitle>Couldn’t load secrets</EmptyTitle>
          <EmptyDescription>
            Nook is unavailable right now ({status}). Try again in a moment.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>{retry}</EmptyContent>
      </Empty>
    </div>
  );
}

function NoSecretsAnywhere({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-lg border border-dashed">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <KeyRound />
          </EmptyMedia>
          <EmptyTitle>No secrets yet</EmptyTitle>
          <EmptyDescription>
            Store an API key or token in a bucket. Agents on your machines find
            it by name. Values are encrypted; you can reveal one here when you
            need it.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" onClick={onCreate}>
            <Plus />
            New secret
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}

function NoSecretsHere({
  bucket,
  inheriting,
  onCreate,
}: {
  bucket: string;
  inheriting: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="rounded-lg border border-dashed">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <KeyRound />
          </EmptyMedia>
          <EmptyTitle className="wrap-anywhere">
            No secrets in {bucket}
          </EmptyTitle>
          <EmptyDescription>
            {inheriting
              ? 'Agents working here find only the inherited secrets below.'
              : 'Agents working here find no secrets yet.'}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" variant="outline" onClick={onCreate}>
            <Plus />
            New secret in <span className="font-mono">{bucket}</span>
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}

function UnknownBucket({ bucket }: { bucket: string }) {
  return (
    <div className="rounded-lg border border-dashed">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchX />
          </EmptyMedia>
          <EmptyTitle className="wrap-anywhere">
            There is no bucket {bucket}
          </EmptyTitle>
          <EmptyDescription>
            It may have been deleted. Buckets are created and deleted on the{' '}
            <Link to="/buckets">Buckets</Link> page.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}

/* ---------- page ---------- */

function DeleteConfirmation({
  secret,
  parents,
  onCancel,
  onConfirm,
  onClose,
}: {
  secret: Secret | null;
  parents: Set<string>;
  onCancel: () => void;
  onConfirm: () => void;
  onClose: (event: Event) => void;
}) {
  const last = useRef<Secret | null>(null);
  if (secret) last.current = secret;
  const shown = secret ?? last.current;
  if (!shown) return null;
  const where =
    shown.bucket === RESERVED
      ? 'Agents working in any bucket'
      : parents.has(shown.bucket)
        ? `Agents working in ${shown.bucket} or a bucket inside it`
        : `Agents working in ${shown.bucket}`;
  return (
    <AlertDialog
      open={secret !== null}
      onOpenChange={(open) => !open && onCancel()}
    >
      <AlertDialogContent onCloseAutoFocus={onClose}>
        <AlertDialogHeader>
          <AlertDialogTitle className="wrap-anywhere">
            Delete <Path>{secretPath(shown)}</Path>?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Its value is deleted and can’t be recovered. {where} will no longer
            find <span className="font-mono">{shown.name}</span>.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Delete secret
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

type Page = ReturnType<typeof useVaultPage>;

function StoredSecrets({
  page,
  list,
}: {
  page: Page;
  list: readonly Secret[];
}) {
  const { selected, saving, highlighted, busy } = page;
  const own = secretsIn(list, selected);
  if (list.length === 0)
    return <NoSecretsAnywhere onCreate={() => page.openCreate()} />;
  if (own.length === 0)
    return (
      <NoSecretsHere
        bucket={selected}
        inheriting={ancestorsOf(selected).some(
          (ancestor) => secretsIn(list, ancestor).length > 0,
        )}
        onCreate={() => page.openCreate(selected)}
      />
    );
  return (
    <section aria-labelledby="stored-heading">
      <ListHeader id="stored-heading" title="Stored here" count={own.length} />
      <ul className="divide-y overflow-hidden rounded-lg border">
        {own.map((secret) => {
          const path = secretPath(secret);
          const isSaving = saving.has(path);
          return (
            <SecretRow
              key={path}
              secret={secret}
              saving={isSaving}
              confirming={page.confirming.has(path)}
              highlighted={highlighted === path}
              actions={
                !isSaving && (
                  <SecretMenu
                    secret={secret}
                    busy={busy}
                    onReveal={page.openReveal}
                    onReplace={page.openReplace}
                    onDelete={page.requestDelete}
                  />
                )
              }
            />
          );
        })}
      </ul>
    </section>
  );
}
function BucketSecrets({ page }: { page: Page }) {
  const { list, secrets } = page;
  if (secrets.isPending) return <SecretsSkeleton />;
  const status = secrets.error instanceof ApiError ? secrets.error.status : 503;
  const failure = (
    <LoadFailure
      compact={list !== undefined}
      cached={list !== undefined}
      busy={page.busy}
      status={status}
      retrying={secrets.isFetching}
      onRetry={() => secrets.refetch()}
    />
  );
  if (!list) return failure;
  return (
    <>
      {secrets.isError && failure}
      <StoredSecrets page={page} list={list} />
      {list.length > 0 && <Inherited bucket={page.selected} secrets={list} />}
    </>
  );
}
function BucketPane({ page }: { page: Page }) {
  const { selected, buckets } = page;
  if (buckets.length > 0 && !buckets.includes(selected))
    return <UnknownBucket bucket={selected} />;
  return (
    <>
      <div className="mb-6 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-mono text-lg font-semibold tracking-tight wrap-anywhere">
            {selected}
          </h2>
          <p className="text-sm text-muted-foreground wrap-anywhere">
            {reachText(selected, page.parents.has(selected), 'its secrets')}
          </p>
        </div>
      </div>
      <BucketSecrets page={page} />
    </>
  );
}
function MobileListStatus({ page }: { page: Page }) {
  if (page.drilled) return null;
  const { secrets } = page;
  if (secrets.isError)
    return (
      <div className="lg:hidden">
        <LoadFailure
          compact
          cached={page.list !== undefined}
          busy={page.busy}
          status={
            secrets.error instanceof ApiError ? secrets.error.status : 503
          }
          retrying={secrets.isFetching}
          onRetry={() => secrets.refetch()}
        />
      </div>
    );
  if (page.list?.length === 0)
    return (
      <div className="mb-6 lg:hidden">
        <NoSecretsAnywhere onCreate={() => page.openCreate()} />
      </div>
    );
  return null;
}

function TreePane({ page }: { page: Page }) {
  const { bucketsQuery, buckets, drilled, selected, counts, secrets } = page;
  return (
    <nav
      aria-label="Buckets"
      className={cn(
        'lg:sticky lg:top-20 lg:w-60 lg:shrink-0 xl:w-68',
        drilled && 'hidden lg:block',
      )}
    >
      <MobileListStatus page={page} />
      <div className="mb-1 flex h-8 items-center border-b pr-2">
        <h2 className={cn(sectionLabel, 'mr-auto')}>Buckets</h2>
        <span className="pr-6 text-xs text-muted-foreground lg:pr-0">
          Secrets
        </span>
      </div>
      {bucketsQuery.isPending ? (
        <BucketTreeSkeleton />
      ) : (
        <BucketTree
          buckets={buckets}
          selected={drilled || page.wide ? selected : null}
          counts={counts}
          loading={secrets.isPending}
        />
      )}
      <p className="mt-4 px-1 text-xs text-muted-foreground">
        Buckets are created and deleted on the{' '}
        <Link
          to="/buckets"
          className="underline underline-offset-4 hover:text-foreground"
        >
          Buckets
        </Link>{' '}
        page.
      </p>
    </nav>
  );
}

export function VaultPage() {
  const page = useVaultPage();
  const { ui, drilled, loaded, busy } = page;
  return (
    <div className="w-full max-w-6xl px-4 pb-24 sm:px-6 md:px-12">
      <div className="flex items-center gap-3 pt-6 pb-2 md:pt-8">
        <h1
          ref={page.heading}
          tabIndex={-1}
          className="mr-auto text-xl font-semibold tracking-tight outline-none"
        >
          Vault
        </h1>
        <Button
          size="sm"
          disabled={!loaded || busy}
          onClick={() => page.openCreate()}
        >
          <Plus />
          New secret
        </Button>
      </div>
      <p
        className={cn(
          'mb-6 max-w-2xl text-sm text-muted-foreground',
          drilled && 'hidden lg:block',
        )}
      >
        Agents find secrets by name, in their bucket and the buckets above it.
        Values are encrypted. You can reveal one here; every reveal is recorded
        in Audit.
      </p>
      <div className="mb-6 empty:hidden">
        {ui.feedback && (
          <WriteFeedback
            feedback={ui.feedback}
            onDismiss={page.dismissFeedback}
            onRetry={page.retry}
          />
        )}
      </div>
      {drilled && (
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 mb-3 lg:hidden"
          asChild
        >
          <Link to="/vault" search={{}}>
            <ChevronLeft />
            All buckets
          </Link>
        </Button>
      )}
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-10">
        <TreePane page={page} />
        <section
          aria-label={`Secrets in ${page.selected}`}
          className={cn('min-w-0 flex-1', !drilled && 'hidden lg:block')}
        >
          <BucketPane page={page} />
        </section>
      </div>
      <VaultDialogs page={page} />
    </div>
  );
}

function VaultDialogs({ page }: { page: Page }) {
  const { ui, setUi, patch } = page;
  const draft = ui.sheet?.draft;
  const replacing =
    draft?.mode === 'replace'
      ? (page.list?.find(
          (secret) => secretPath(secret) === secretPath(draft),
        ) ?? null)
      : null;
  return (
    <>
      <SecretSheet
        sheet={ui.sheet}
        buckets={page.buckets}
        parents={page.parents}
        replacing={replacing}
        onChange={(sheet) => patch({ sheet })}
        onClose={() => patch({ sheet: null })}
        onSubmit={page.submitSheet}
        onConfirmReplace={page.confirmReplace}
        onBack={() =>
          setUi((current) =>
            current.sheet
              ? { ...current, sheet: { ...current.sheet, confirming: false } }
              : current,
          )
        }
      />
      <DeleteConfirmation
        secret={ui.deleting}
        parents={page.parents}
        onCancel={() => patch({ deleting: null })}
        onConfirm={page.confirmDelete}
        onClose={(event) => {
          event.preventDefault();
          const trigger = page.deleteTrigger.current;
          if (trigger?.isConnected) trigger.focus();
          else page.heading.current?.focus();
        }}
      />
      {page.revealing && (
        <Suspense fallback={null}>
          <RevealDialog secret={page.revealing} onClose={page.closeReveal} />
        </Suspense>
      )}
    </>
  );
}
