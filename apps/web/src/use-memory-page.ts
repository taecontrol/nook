import { type Memory, readLineage } from '@nook/contract';
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useBucketList } from './buckets-api';
import {
  memoriesOptions,
  memoryCountsOptions,
  memoryOptions,
  memorySearchOptions,
} from './memory-api';

function useDesktop() {
  const [desktop, setDesktop] = useState(
    () => matchMedia('(min-width: 1024px)').matches,
  );
  useEffect(() => {
    const media = matchMedia('(min-width: 1024px)');
    const changed = () => setDesktop(media.matches);
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  return desktop;
}
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
function visibleBuckets(bucket: string, scope: 'bucket' | 'inherited') {
  return scope === 'bucket' ? [bucket] : readLineage(bucket);
}
function searchSelection(
  searching: boolean,
  placeholder: boolean,
  result: string | undefined,
  newest: string | undefined,
) {
  if (!searching) return newest;
  return placeholder ? undefined : result;
}
function useAutoSelection(
  desktop: boolean,
  firstId: string | undefined,
  search: { memory?: string; q?: string },
  bucket: string,
  scope: 'bucket' | 'inherited',
  navigate: ReturnType<typeof useNavigate>,
) {
  useEffect(() => {
    if (desktop && firstId && !search.memory)
      void navigate({
        to: '/memory',
        search: { bucket, scope, memory: firstId, q: search.q },
        replace: true,
      });
  }, [desktop, firstId, search.memory, search.q, bucket, scope, navigate]);
}
function useQueryDraft(q: string, navigate: (q: string | undefined) => void) {
  const [draft, setDraft] = useState(q);
  const sent = useRef(q);
  useEffect(() => {
    if (q !== sent.current) {
      sent.current = q;
      setDraft(q);
    }
  }, [q]);
  const commit = (value: string) => {
    const next = value.trim();
    if (next === sent.current.trim()) return;
    sent.current = next;
    navigate(next || undefined);
  };
  const latest = useRef(commit);
  latest.current = commit;
  useEffect(() => {
    const timer = setTimeout(() => latest.current(draft), 250);
    return () => clearTimeout(timer);
  }, [draft]);
  return {
    draft,
    setDraft,
    submit: () => commit(draft),
    clear: () => {
      setDraft('');
      commit('');
    },
  };
}
export function useMemoryPage() {
  const search = useSearch({ from: '/owner/memory' });
  const navigate = useNavigate({ from: '/memory' });
  const queries = useQueryClient();
  const desktop = useDesktop();
  const bucket = search.bucket ?? 'me';
  const scope = search.scope ?? 'inherited';
  const q = search.q?.trim() ?? '';
  const searching = Boolean(q);
  const draft = useQueryDraft(
    q,
    (next) =>
      void navigate({
        search: { bucket, scope, memory: search.memory, q: next },
        replace: true,
      }),
  );
  const results = useQuery({
    ...memorySearchOptions(bucket, scope, q),
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === bucket &&
      previousQuery?.queryKey[2] === scope
        ? previous
        : undefined,
  });
  const buckets = useBucketList();
  const countsQuery = useQuery(memoryCountsOptions);
  const list = useInfiniteQuery(memoriesOptions(bucket, scope));
  const records = list.data?.pages.flatMap((page) => page.memories) ?? [];
  const detail = useQuery({
    ...memoryOptions(search.memory ?? ''),
    enabled: Boolean(search.memory),
  });
  const visible = visibleBuckets(bucket, scope);
  const selected = visibleMemory(detail.data, visible);
  const { counts, total, firstRun } = countSummary(
    countsQuery.data?.counts,
    visible,
  );
  const firstId = searchSelection(
    searching,
    results.isPlaceholderData,
    results.data?.results[0]?.id,
    records[0]?.id,
  );
  useAutoSelection(desktop, firstId, search, bucket, scope, navigate);
  return {
    search,
    bucket,
    scope,
    q,
    searching,
    draft,
    results,
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
      void navigate({
        search: {
          bucket,
          scope: next,
          q: q || undefined,
          memory: q ? search.memory : undefined,
        },
        replace: true,
      }),
    prefetch: (id: string) => void queries.prefetchQuery(memoryOptions(id)),
  };
}
export type MemoryPageModel = ReturnType<typeof useMemoryPage>;
