import {
  bucketLimits,
  bucketPathMessages,
  RESERVED_BUCKET,
} from '@nook/contract';
import { cn } from 'cn';
import { MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import {
  BranchToggle,
  type BucketNode,
  Guides,
  TreeBranches,
} from './bucket-tree';
import { formatDate } from './time';

export type OutlineState = {
  collapsed: Set<string>;
  highlighted: string | null;
  existingMatch: string | null;
  pending: Set<string>;
  busy: boolean;
};

export type OutlineActions = {
  toggle: (path: string, open: boolean) => void;
  createInside: (path: string) => void;
  focusField: () => void;
  requestDelete: (path: string, trigger: HTMLButtonElement | null) => void;
};

function deleteBlocker(node: BucketNode) {
  if (node.path === RESERVED_BUCKET)
    return 'me is reserved: it always exists and every machine can read it.';
  if (node.children.length > 0) return 'Delete its child buckets first.';
  return null;
}

function RowMenu({
  node,
  actions,
  onOpenChange,
  busy,
}: {
  node: BucketNode;
  actions: OutlineActions;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
}) {
  const blocker = deleteBlocker(node);
  // Depth counts from 0, so the deepest accepted level has no children.
  const atDeepest = node.depth >= bucketLimits.levels - 1;
  const toField = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
          variant="ghost"
          size="icon-xs"
          aria-label={`Actions for ${node.path}`}
          className=""
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-64"
        onCloseAutoFocus={(event) => {
          if (!toField.current) return;
          toField.current = false;
          event.preventDefault();
          actions.focusField();
        }}
      >
        <DropdownMenuLabel className="flex flex-col font-normal">
          <span className="font-mono text-xs wrap-anywhere">{node.path}</span>
          {node.createdAt && (
            <span className="text-xs text-muted-foreground">
              Created {formatDate(node.createdAt)}
            </span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={busy || atDeepest}
          onSelect={() => {
            toField.current = true;
            actions.createInside(node.path);
          }}
        >
          <Plus />
          Create inside
        </DropdownMenuItem>
        {atDeepest && (
          <p className="px-2 pb-1.5 text-xs text-muted-foreground">
            {bucketPathMessages.depth}
          </p>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={busy || blocker !== null}
          onSelect={() => actions.requestDelete(node.path, triggerRef.current)}
        >
          <Trash2 />
          Delete bucket…
        </DropdownMenuItem>
        {blocker && (
          <p className="px-2 pb-1.5 text-xs text-muted-foreground">{blocker}</p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function rowColor(node: BucketNode, emphasized: boolean, menuOpen: boolean) {
  if (node.ghost) return 'rounded-none bg-muted text-muted-foreground';
  if (emphasized) return 'bg-accent ring-1 ring-ring/40';
  return menuOpen ? 'bg-accent' : 'hover:bg-accent/60';
}
function RowToggle({ node, open }: { node: BucketNode; open: boolean }) {
  return (
    <>
      {' '}
      {node.ghost ? (
        <Plus className="size-3.5" aria-hidden />
      ) : (
        <BranchToggle node={node} open={open} />
      )}
    </>
  );
}
function RowBadges({ node, matched }: { node: BucketNode; matched: boolean }) {
  return (
    <>
      {' '}
      {node.path === RESERVED_BUCKET && (
        <Badge variant="secondary">reserved</Badge>
      )}
      {node.ghost && <Badge variant="outline">new</Badge>}
      {matched && <Badge variant="outline">exists</Badge>}
    </>
  );
}
function RowDate({ node, pending }: { node: BucketNode; pending: boolean }) {
  return (
    <>
      {' '}
      {pending ? (
        <Spinner className="size-3" aria-label="Saving" />
      ) : node.createdAt ? (
        formatDate(node.createdAt)
      ) : null}
    </>
  );
}
function Row({
  node,
  open,
  state,
  actions,
}: {
  node: BucketNode;
  open: boolean;
  state: OutlineState;
  actions: OutlineActions;
}) {
  const highlighted = state.highlighted === node.path;
  const matched = state.existingMatch === node.path;
  const pending = state.pending.has(node.path);
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div
      data-path={node.path}
      className={cn(
        'group/row flex min-h-8 items-stretch rounded-md pr-1 transition-colors duration-700 sm:min-h-7',
        rowColor(node, highlighted || matched, menuOpen),
      )}
    >
      <Guides depth={node.depth} />
      <div className="flex w-5 shrink-0 items-center justify-center sm:w-6">
        <RowToggle node={node} open={open} />
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 py-1.5 pl-1 sm:py-1">
        <span
          className={cn(
            'min-w-0 text-sm wrap-break-word',
            node.ghost ? 'italic' : 'font-medium',
            node.depth > 0 && !node.ghost && 'font-normal',
          )}
        >
          {node.name}
        </span>
        <RowBadges node={node} matched={matched} />
      </div>
      <div className="hidden w-28 shrink-0 items-center justify-end pr-2 text-xs tabular-nums text-muted-foreground sm:flex">
        <RowDate node={node} pending={pending} />
      </div>
      <div className="flex w-7 shrink-0 items-center justify-center sm:opacity-0 sm:group-hover/row:opacity-100 sm:group-focus-within/row:opacity-100">
        {!node.ghost && !pending && (
          <RowMenu
            node={node}
            actions={actions}
            onOpenChange={setMenuOpen}
            busy={state.busy}
          />
        )}
        {pending && <Spinner className="size-3 sm:hidden" aria-hidden />}
      </div>
    </div>
  );
}

export function Outline({
  nodes,
  state,
  actions,
}: {
  nodes: BucketNode[];
  state: OutlineState;
  actions: OutlineActions;
}) {
  return (
    <ul aria-label="All buckets">
      <TreeBranches
        nodes={nodes}
        collapsed={state.collapsed}
        onToggle={actions.toggle}
        row={(node, open) => (
          <Row node={node} open={open} state={state} actions={actions} />
        )}
      />
    </ul>
  );
}

const skeletonRows = [
  { depth: 0, id: 'row-0', shape: <Skeleton className="h-4 w-10" /> },
  { depth: 0, id: 'row-1', shape: <Skeleton className="h-4 w-20" /> },
  { depth: 1, id: 'row-2', shape: <Skeleton className="h-4 w-24" /> },
  { depth: 1, id: 'row-3', shape: <Skeleton className="h-4 w-16" /> },
  { depth: 0, id: 'row-4', shape: <Skeleton className="h-4 w-12" /> },
  { depth: 1, id: 'row-5', shape: <Skeleton className="h-4 w-28" /> },
  { depth: 2, id: 'row-6', shape: <Skeleton className="h-4 w-14" /> },
];

export function OutlineSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading buckets">
      {skeletonRows.map((row) => (
        <div
          key={row.id}
          className="flex min-h-8 items-stretch pr-1 sm:min-h-7"
        >
          <Guides depth={row.depth} />
          <div className="flex w-5 shrink-0 items-center justify-center sm:w-6">
            <Skeleton className="size-3" />
          </div>
          <div className="flex flex-1 items-center pl-1">{row.shape}</div>
          <div className="hidden w-28 items-center justify-end pr-2 sm:flex">
            <Skeleton className="h-3 w-20" />
          </div>
          <div className="w-7" />
        </div>
      ))}
    </div>
  );
}
