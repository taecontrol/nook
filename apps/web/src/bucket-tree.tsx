import { type Bucket, type BucketScope, bucketLineage } from '@nook/contract';
import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { ChevronRight, Dot } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { memorySearch } from './memory-navigation';
import { nameOf, parentOf } from './paths';

export type BucketNode = {
  path: string;
  name: string;
  depth: number;
  createdAt: string | null;
  ghost: boolean;
  children: BucketNode[];
};

/** Nests buckets (and preview ghosts) by path, siblings sorted by name. */
export function buildBucketTree(
  buckets: readonly Bucket[],
  ghosts: string[],
): BucketNode[] {
  const nodes = new Map<string, BucketNode>();
  const entries = [
    ...buckets.map((bucket) => ({
      path: bucket.path,
      createdAt: bucket.createdAt,
      ghost: false,
    })),
    ...ghosts.map((path) => ({ path, createdAt: null, ghost: true })),
  ].sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  const roots: BucketNode[] = [];
  for (const entry of entries) {
    if (nodes.has(entry.path)) continue;
    const node: BucketNode = {
      ...entry,
      name: nameOf(entry.path),
      depth: entry.path.split('/').length - 1,
      children: [],
    };
    nodes.set(entry.path, node);
    const parent = parentOf(entry.path);
    (parent ? (nodes.get(parent)?.children ?? roots) : roots).push(node);
  }
  const sort = (list: BucketNode[]) => {
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const node of list) sort(node.children);
  };
  sort(roots);
  return roots;
}

/** Buckets that contain other buckets. */
export function parentBuckets(paths: readonly string[]) {
  return new Set(
    paths.filter((path) => paths.some((other) => other.startsWith(`${path}/`))),
  );
}

/** Collapsed branches, except those on the way to a revealed path. */
export function useCollapsed(reveal: readonly (string | null | undefined)[]) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const revealed = reveal.filter((path): path is string => !!path).join('\n');
  const visible = useMemo(() => {
    if (!revealed) return collapsed;
    const next = new Set(collapsed);
    for (const path of revealed.split('\n'))
      for (const prefix of bucketLineage(path)) next.delete(prefix);
    return next;
  }, [collapsed, revealed]);
  return {
    visible,
    setCollapsed,
    toggle: (path: string, open: boolean) =>
      setCollapsed((current) => {
        const next = new Set(current);
        if (open) next.delete(path);
        else next.add(path);
        return next;
      }),
  };
}

const levels = ['one', 'two', 'three', 'four', 'five'];
/** One vertical guide per ancestor level. */
export function Guides({
  depth,
  className = 'w-5 sm:w-6',
}: {
  depth: number;
  className?: string;
}) {
  return levels.slice(0, depth).map((level) => (
    <div
      key={level}
      className={cn('flex shrink-0 justify-center', className)}
      aria-hidden
    >
      <Separator orientation="vertical" />
    </div>
  ));
}

/** Expands or collapses a branch; a leaf shows a dot. */
export function BranchToggle({
  node,
  open,
}: {
  node: BucketNode;
  open: boolean;
}) {
  return node.children.length > 0 ? (
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
  );
}

type BranchProps = {
  collapsed: Set<string>;
  onToggle: (path: string, open: boolean) => void;
  row: (node: BucketNode, open: boolean) => ReactNode;
};
function TreeBranch({ node, ...props }: BranchProps & { node: BucketNode }) {
  const open = !props.collapsed.has(node.path);
  return (
    <li data-bucket={node.path}>
      <Collapsible
        open={open}
        onOpenChange={(value) => props.onToggle(node.path, value)}
      >
        {props.row(node, open)}
        {node.children.length > 0 && (
          <CollapsibleContent asChild>
            <ul>
              <TreeBranches nodes={node.children} {...props} />
            </ul>
          </CollapsibleContent>
        )}
      </Collapsible>
    </li>
  );
}
/** Nested collapsible list items; `row` draws each bucket. */
export function TreeBranches({
  nodes,
  ...props
}: BranchProps & { nodes: readonly BucketNode[] }) {
  return nodes.map((node) => (
    <TreeBranch key={node.path} node={node} {...props} />
  ));
}

type TreeState = {
  to: '/vault' | '/memory';
  noun: 'secret' | 'memory';
  scope: BucketScope;
  query?: string;
  /** The bucket shown on the right; null on a phone's bucket list. */
  selected: string | null;
  counts: Map<string, number> | null;
  loading: boolean;
};

function Count({ path, state }: { path: string; state: TreeState }) {
  if (state.loading) return <Skeleton className="h-3 w-4" />;
  if (!state.counts) return null;
  const count = state.counts.get(path) ?? 0;
  return (
    <span
      className={cn(
        'min-w-4 text-right text-xs tabular-nums text-muted-foreground',
        count === 0 && 'text-muted-foreground/60',
      )}
    >
      <span className="sr-only">
        {count}{' '}
        {count === 1
          ? state.noun
          : state.noun === 'memory'
            ? 'memories'
            : 'secrets'}
      </span>
      <span aria-hidden>{count}</span>
    </span>
  );
}

function bucketSearch(state: TreeState, path: string) {
  return state.to === '/memory'
    ? memorySearch({ bucket: path, scope: state.scope, q: state.query })
    : { bucket: path };
}

function Row({
  node,
  open,
  state,
}: {
  node: BucketNode;
  open: boolean;
  state: TreeState;
}) {
  const selected = state.selected === node.path;
  return (
    <div
      data-path={node.path}
      className={cn(
        'flex min-h-11 items-stretch rounded-md transition-colors lg:min-h-8',
        selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
      )}
    >
      <Guides depth={node.depth} />
      <div className="flex w-5 shrink-0 items-center justify-center sm:w-6">
        <BranchToggle node={node} open={open} />
      </div>
      <Link
        to={state.to}
        search={bucketSearch(state, node.path)}
        aria-current={selected ? 'page' : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pr-2 pl-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span
          className={cn(
            'min-w-0 flex-1 wrap-break-word',
            selected || node.depth === 0 ? 'font-medium' : 'font-normal',
          )}
        >
          {node.name}
        </span>
        <Count path={node.path} state={state} />
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground lg:hidden"
          aria-hidden
        />
      </Link>
    </div>
  );
}

export function BucketTree({
  buckets,
  selected,
  counts,
  loading,
  to = '/vault',
  noun = 'secret',
  scope = 'inherited',
  query,
}: {
  buckets: readonly string[];
  selected: string | null;
  counts: Map<string, number> | null;
  loading: boolean;
  to?: '/vault' | '/memory';
  noun?: 'secret' | 'memory';
  scope?: BucketScope;
  query?: string;
}) {
  const nodes = useMemo(
    () =>
      buildBucketTree(
        buckets.map((path) => ({ path, createdAt: '' })),
        [],
      ),
    [buckets],
  );
  // The way to the selected bucket always stays open.
  const { visible, toggle } = useCollapsed([selected]);
  const state: TreeState = {
    to,
    noun,
    scope,
    query,
    selected,
    counts,
    loading,
  };
  return (
    <ul aria-label="Buckets">
      <TreeBranches
        nodes={nodes}
        collapsed={visible}
        onToggle={toggle}
        row={(node, open) => <Row node={node} open={open} state={state} />}
      />
    </ul>
  );
}

const skeletonRows = [
  { depth: 0, id: 'a', shape: <Skeleton className="h-4 w-8" /> },
  { depth: 0, id: 'b', shape: <Skeleton className="h-4 w-16" /> },
  { depth: 1, id: 'c', shape: <Skeleton className="h-4 w-20" /> },
  { depth: 0, id: 'd', shape: <Skeleton className="h-4 w-10" /> },
  { depth: 1, id: 'e', shape: <Skeleton className="h-4 w-12" /> },
  { depth: 2, id: 'f', shape: <Skeleton className="h-4 w-28" /> },
];
export function BucketTreeSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading buckets">
      {skeletonRows.map((row) => (
        <div key={row.id} className="flex min-h-11 items-stretch lg:min-h-8">
          <Guides depth={row.depth} />
          <div className="flex w-5 shrink-0 items-center justify-center sm:w-6">
            <Skeleton className="size-3" />
          </div>
          <div className="flex flex-1 items-center pl-1">{row.shape}</div>
        </div>
      ))}
    </div>
  );
}
