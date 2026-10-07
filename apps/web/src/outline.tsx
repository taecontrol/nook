import { cn } from 'cn';
import { ChevronRight, Dot, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { type Bucket, formatDate, nameOf, parentOf, RESERVED } from './paths';

export type OutlineNode = {
  path: string;
  name: string;
  depth: number;
  createdAt: string | null;
  ghost: boolean;
  children: OutlineNode[];
};

/** Nests buckets (and preview ghosts) by path, siblings sorted by name. */
export function buildOutline(
  buckets: Bucket[],
  ghosts: string[],
): OutlineNode[] {
  const nodes = new Map<string, OutlineNode>();
  const entries = [
    ...buckets.map((bucket) => ({
      path: bucket.path,
      createdAt: bucket.createdAt,
      ghost: false,
    })),
    ...ghosts.map((path) => ({ path, createdAt: null, ghost: true })),
  ].sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  const roots: OutlineNode[] = [];
  for (const entry of entries) {
    if (nodes.has(entry.path)) continue;
    const node: OutlineNode = {
      ...entry,
      name: nameOf(entry.path),
      depth: entry.path.split('/').length - 1,
      children: [],
    };
    nodes.set(entry.path, node);
    const parent = parentOf(entry.path);
    (parent ? (nodes.get(parent)?.children ?? roots) : roots).push(node);
  }
  const sort = (list: OutlineNode[]) => {
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const node of list) sort(node.children);
  };
  sort(roots);
  return roots;
}

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

export function Guides({ depth }: { depth: number }) {
  return ['root', 'one', 'two', 'three', 'four']
    .slice(0, depth)
    .map((level) => (
      <div
        key={level}
        className="flex w-5 shrink-0 justify-center sm:w-6"
        aria-hidden
      >
        <Separator orientation="vertical" />
      </div>
    ));
}

function deleteBlocker(node: OutlineNode) {
  if (node.path === RESERVED)
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
  node: OutlineNode;
  actions: OutlineActions;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
}) {
  const blocker = deleteBlocker(node);
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
          disabled={busy || node.depth >= 5}
          onSelect={() => {
            toField.current = true;
            actions.createInside(node.path);
          }}
        >
          <Plus />
          Create inside
        </DropdownMenuItem>
        {node.depth >= 5 && (
          <p className="px-2 pb-1.5 text-xs text-muted-foreground">
            A bucket path can have at most 6 levels.
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

function rowColor(node: OutlineNode, emphasized: boolean, menuOpen: boolean) {
  if (node.ghost) return 'rounded-none bg-muted text-muted-foreground';
  if (emphasized) return 'bg-accent ring-1 ring-ring/40';
  return menuOpen ? 'bg-accent' : 'hover:bg-accent/60';
}
function RowToggle({ node, open }: { node: OutlineNode; open: boolean }) {
  return (
    <>
      {' '}
      {node.ghost ? (
        <Plus className="size-3.5" aria-hidden />
      ) : node.children.length > 0 ? (
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-5"
            aria-label={`${open ? 'Collapse' : 'Expand'} ${node.path}`}
          >
            <ChevronRight
              className={cn('transition-transform', open && 'rotate-90')}
            />
          </Button>
        </CollapsibleTrigger>
      ) : (
        <Dot className="size-4 text-muted-foreground" aria-hidden />
      )}
    </>
  );
}
function RowBadges({ node, matched }: { node: OutlineNode; matched: boolean }) {
  return (
    <>
      {' '}
      {node.path === RESERVED && <Badge variant="secondary">reserved</Badge>}
      {node.ghost && <Badge variant="outline">new</Badge>}
      {matched && <Badge variant="outline">exists</Badge>}
    </>
  );
}
function RowDate({ node, pending }: { node: OutlineNode; pending: boolean }) {
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
  node: OutlineNode;
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

function Branch({
  node,
  state,
  actions,
}: {
  node: OutlineNode;
  state: OutlineState;
  actions: OutlineActions;
}) {
  const open = !state.collapsed.has(node.path);
  return (
    <li data-bucket={node.path}>
      <Collapsible
        open={open}
        onOpenChange={(value) => actions.toggle(node.path, value)}
      >
        <Row node={node} open={open} state={state} actions={actions} />
        {node.children.length > 0 && (
          <CollapsibleContent asChild>
            <ul>
              {node.children.map((child) => (
                <Branch
                  key={child.path}
                  node={child}
                  state={state}
                  actions={actions}
                />
              ))}
            </ul>
          </CollapsibleContent>
        )}
      </Collapsible>
    </li>
  );
}

export function Outline({
  nodes,
  state,
  actions,
}: {
  nodes: OutlineNode[];
  state: OutlineState;
  actions: OutlineActions;
}) {
  return (
    <ul aria-label="All buckets">
      {nodes.map((node) => (
        <Branch key={node.path} node={node} state={state} actions={actions} />
      ))}
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
