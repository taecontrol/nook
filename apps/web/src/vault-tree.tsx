import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { ChevronRight, Dot } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import { buildOutline, Guides, type OutlineNode } from './outline';
import { lineage } from './paths';

type TreeState = {
  /** The bucket shown on the right; null on a phone's bucket list. */
  selected: string | null;
  counts: Map<string, number> | null;
  loading: boolean;
  collapsed: Set<string>;
  toggle: (path: string, open: boolean) => void;
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
      {count}
      <span className="sr-only">{count === 1 ? ' secret' : ' secrets'}</span>
    </span>
  );
}

function Row({
  node,
  open,
  state,
}: {
  node: OutlineNode;
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
        {node.children.length > 0 ? (
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
      </div>
      <Link
        to="/vault"
        search={{ bucket: node.path }}
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

function Branch({ node, state }: { node: OutlineNode; state: TreeState }) {
  const open = !state.collapsed.has(node.path);
  return (
    <li>
      <Collapsible
        open={open}
        onOpenChange={(value) => state.toggle(node.path, value)}
      >
        <Row node={node} open={open} state={state} />
        {node.children.length > 0 && (
          <CollapsibleContent asChild>
            <ul>
              {node.children.map((child) => (
                <Branch key={child.path} node={child} state={state} />
              ))}
            </ul>
          </CollapsibleContent>
        )}
      </Collapsible>
    </li>
  );
}

export function BucketTree({
  buckets,
  selected,
  counts,
  loading,
}: {
  buckets: readonly string[];
  selected: string | null;
  counts: Map<string, number> | null;
  loading: boolean;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const nodes = useMemo(
    () =>
      buildOutline(
        buckets.map((path) => ({ path, createdAt: '' })),
        [],
      ),
    [buckets],
  );
  // The way to the selected bucket always stays open.
  const visible = useMemo(() => {
    if (!selected) return collapsed;
    const next = new Set(collapsed);
    for (const prefix of lineage(selected)) next.delete(prefix);
    return next;
  }, [collapsed, selected]);
  const state: TreeState = {
    selected,
    counts,
    loading,
    collapsed: visible,
    toggle: (path, open) =>
      setCollapsed((current) => {
        const next = new Set(current);
        if (open) next.delete(path);
        else next.add(path);
        return next;
      }),
  };
  return (
    <ul aria-label="Buckets">
      {nodes.map((node) => (
        <Branch key={node.path} node={node} state={state} />
      ))}
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
