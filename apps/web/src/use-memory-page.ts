import { type Memory, RESERVED_BUCKET, readLineage } from '@nook/contract';
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useBucketList } from './buckets-api';
import { useDesktop } from './hooks/use-desktop';
import {
  memoriesOptions,
  memoryCountsOptions,
  memoryOptions,
} from './memory-api';

function countSummary(
  rows: readonly { bucket: string; count: number }[] | undefined,
  visible: readonly string[],
) {
  const counts = rows
    ? new Map(rows.map((row) => [row.bucket, row.count]))
    : null;
  return {
    counts,
    total: counts
      ? visible.reduce((n, path) => n + (counts.get(path) ?? 0), 0)
      : null,
    firstRun:
      counts !== null && [...counts.values()].every((count) => count === 0),
  };
}
function visibleMemory(detail: Memory | undefined, visible: readonly string[]) {
  return detail && visible.includes(detail.bucket) ? detail : null;
}
function useAutoSelection(
  desktop: boolean,
  firstId: string | undefined,
  search: { memory?: string },
  bucket: string,
  scope: 'bucket' | 'inherited',
  navigate: ReturnType<typeof useNavigate>,
) {
  useEffect(() => {
    if (desktop && firstId && !search.memory)
      void navigate({
        to: '/memory',
        search: { bucket, scope, memory: firstId },
        replace: true,
      });
  }, [desktop, firstId, search.memory, bucket, scope, navigate]);
}
export function useMemoryPage() {
  const search = useSearch({ from: '/owner/memory' });
  const navigate = useNavigate({ from: '/memory' });
  const queries = useQueryClient();
  const desktop = useDesktop();
  const bucket = search.bucket ?? RESERVED_BUCKET;
  const scope = search.scope ?? 'inherited';
  const buckets = useBucketList();
  const countsQuery = useQuery(memoryCountsOptions);
  const list = useInfiniteQuery(memoriesOptions(bucket, scope));
  const records = list.data?.pages.flatMap((page) => page.memories) ?? [];
  const detail = useQuery({
    ...memoryOptions(search.memory ?? ''),
    enabled: Boolean(search.memory),
  });
  const visible = scope === 'bucket' ? [bucket] : readLineage(bucket);
  const selected = visibleMemory(detail.data, visible);
  const { counts, total, firstRun } = countSummary(
    countsQuery.data?.counts,
    visible,
  );
  const firstId = records[0]?.id;
  useAutoSelection(desktop, firstId, search, bucket, scope, navigate);
  return {
    search,
    bucket,
    scope,
    desktop,
    buckets,
    counts,
    countsQuery,
    list,
    records,
    detail,
    selected,
    total,
    firstRun,
    browse: !desktop && !search.bucket,
    detailOpen: !desktop && Boolean(search.memory),
    changeScope: (next: 'bucket' | 'inherited') =>
      void navigate({ search: { bucket, scope: next }, replace: true }),
    prefetch: (id: string) => void queries.prefetchQuery(memoryOptions(id)),
  };
}
export type MemoryPageModel = ReturnType<typeof useMemoryPage>;
