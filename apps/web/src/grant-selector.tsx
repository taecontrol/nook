import { canRead, canWrite, readOnlyText } from '@nook/contract';
import { cn } from 'cn';
import { CircleAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { FieldError } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import type { GrantSelection } from './grant-selection';
import { buildOutline, type OutlineNode } from './outline';

function rowAccess(selection: GrantSelection, path: string) {
  if (selection.all) return 'Included';
  if (selection.roots.includes(path)) return 'Write';
  const parent = selection.roots.find((root) => path.startsWith(`${root}/`));
  if (parent) return `Via ${parent}`;
  return canRead(selection.grant, path) ? 'Read only' : 'Hidden';
}
function GrantBranch({
  node,
  selection,
  busy,
}: {
  node: OutlineNode;
  selection: GrantSelection;
  busy: boolean;
}) {
  const write = canWrite(selection.grant, node.path);
  const covered = write && !selection.roots.includes(node.path);
  const id = `grant-${node.path}`;
  return (
    <li data-grant-path={node.path}>
      <div
        className={cn(
          'relative flex min-h-9 items-stretch rounded-md px-2',
          write && 'bg-accent/50',
        )}
      >
        {['one', 'two', 'three', 'four', 'five']
          .slice(0, node.depth)
          .map((level) => (
            <div
              key={level}
              className="flex w-3 shrink-0 justify-center sm:w-4"
              aria-hidden
            >
              <Separator orientation="vertical" />
            </div>
          ))}
        <div className="flex min-w-0 flex-1 items-start gap-2 py-2">
          <Checkbox
            id={id}
            aria-label={node.path}
            checked={write}
            disabled={busy || selection.all || covered}
            onCheckedChange={() => selection.toggle(node.path)}
            className="mt-0.5"
          />
          <Label htmlFor={id} className="flex min-w-0 flex-1">
            <span className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-2 gap-y-1">
              <span
                className={cn(
                  'min-w-0 text-sm font-normal leading-5 wrap-anywhere',
                  node.depth === 0 && 'font-medium',
                )}
              >
                {node.name}
              </span>
              <span
                className={cn(
                  'text-xs font-normal wrap-anywhere',
                  write ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {rowAccess(selection, node.path)}
              </span>
            </span>
          </Label>
        </div>
      </div>
      {node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <GrantBranch
              key={child.path}
              node={child}
              selection={selection}
              busy={busy}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
function BucketChecklist({
  selection,
  busy,
}: {
  selection: GrantSelection;
  busy: boolean;
}) {
  const { buckets } = selection;
  if (buckets.isPending)
    return (
      <div
        role="status"
        aria-label="Loading buckets"
        className="flex flex-col gap-4 p-3"
      >
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-32" />
        <p className="text-xs text-muted-foreground">
          Loading the bucket outline…
        </p>
      </div>
    );
  if (buckets.isError)
    return (
      <div className="p-3">
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>Couldn't load buckets</AlertTitle>
          <AlertDescription>
            <p>
              Check your connection and try again. You can still choose All
              buckets or deny this request.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void selection.retry()}
              disabled={busy}
            >
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  return (
    <fieldset
      aria-label="Bucket access"
      className="max-h-80 overflow-y-auto overscroll-contain p-1"
    >
      <ul>
        {buildOutline(buckets.data, []).map((node) => (
          <GrantBranch
            key={node.path}
            node={node}
            selection={selection}
            busy={busy}
          />
        ))}
      </ul>
    </fieldset>
  );
}
export function GrantSelector({
  selection,
  busy,
}: {
  selection: GrantSelection;
  busy: boolean;
}) {
  return (
    <section
      className="flex min-w-0 flex-col gap-3"
      aria-labelledby="bucket-access-title"
    >
      <div>
        <h2 id="bucket-access-title" className="text-sm font-medium">
          Bucket access
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Checked buckets allow read and write, including all current and future
          descendants.
        </p>
      </div>
      <div className="overflow-hidden rounded-lg border">
        <div className="relative flex items-start gap-2 border-b bg-muted/50 px-3 py-3">
          <Checkbox
            id="all-buckets"
            aria-label="All buckets"
            checked={selection.all}
            disabled={busy}
            onCheckedChange={(value) => selection.toggleAll(value === true)}
            className="mt-0.5"
          />
          <Label htmlFor="all-buckets" className="flex min-w-0 flex-1">
            <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
              <span>All buckets</span>
              <span className="text-xs font-normal text-muted-foreground">
                Every current and future bucket.
              </span>
            </span>
          </Label>
        </div>
        <BucketChecklist selection={selection} busy={busy} />
      </div>
      {selection.error && (
        <FieldError role="alert">{selection.error}</FieldError>
      )}
      {selection.all ? (
        <p className="text-xs leading-5 text-muted-foreground">
          This machine can read and write everywhere.
        </p>
      ) : (
        <p className="text-xs leading-5 text-muted-foreground">
          <span>{readOnlyText(selection.grant)}</span>.{' '}
          <span>All other buckets stay hidden.</span>
        </p>
      )}
      <p className="text-xs leading-5 text-muted-foreground">
        To change access later, revoke this machine and log in again.
      </p>
    </section>
  );
}
