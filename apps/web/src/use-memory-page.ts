import { type Memory, readLineage } from '@nook/contract';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from './api-client';
import { useBucketList } from './buckets-api';
import { useDesktop } from './hooks/use-desktop';
import {
  memoryHistoryOptions,
  memoryOptions,
  memoryWriteGate,
  useMemoryQueries,
} from './memory-api';
import {
  type MemorySearch,
  memoryLocation,
  memoryQueryText,
  memorySearch,
} from './memory-location';
import { useMemoryForget } from './use-memory-forget';

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
function visibleMemory(
  detail: Memory | undefined,
  visible: readonly string[],
  error: Error | null,
) {
  if (error instanceof ApiError && error.status === 404) return null;
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
function forgetOrder(
  searching: boolean,
  results: readonly { id: string }[] | undefined,
  records: readonly { id: string }[],
) {
  return (searching ? (results ?? []) : records).map((row) => row.id);
}
function useAutoSelection(
  desktop: boolean,
  firstId: string | undefined,
  memory: string | undefined,
  navigate: ReturnType<typeof useNavigate>,
) {
  const router = useRouter();
  useEffect(() => {
    if (
      desktop &&
      firstId &&
      !memory &&
      router.latestLocation.pathname === '/memory'
    )
      void navigate({
        to: '/memory',
        search: (previous: MemorySearch) =>
          previous.memory
            ? previous
            : memorySearch(memoryLocation(previous), {
                ...previous,
                memory: firstId,
              }),
        replace: true,
      });
  }, [desktop, firstId, memory, navigate, router]);
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
    const next = memoryQueryText(value);
    if (next === sent.current) return;
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
function useHistoryNavigation(
  search: MemorySearch,
  navigate: ReturnType<typeof useNavigate>,
) {
  const queries = useQueryClient();
  const historyNavigate = (patch: Partial<MemorySearch>, replace = false) =>
    void navigate({
      to: '/memory',
      search: (previous: MemorySearch) =>
        memorySearch(memoryLocation(previous), { ...previous, ...patch }),
      replace,
    });
  return {
    historyOpen: search.history === '1' || search.version !== undefined,
    version: search.version,
    changes: search.changes === '1',
    prefetchHistory: () => {
      if (search.memory)
        memoryWriteGate.preload(
          queries,
          memoryHistoryOptions(
            search.memory,
            queries.getQueryData(memoryOptions(search.memory).queryKey)
              ?.version,
          ),
        );
    },
    openHistory: () => historyNavigate({ history: '1' }),
    closeHistory: () =>
      historyNavigate({
        history: undefined,
        version: undefined,
        changes: undefined,
      }),
    showAllVersions: () =>
      historyNavigate({ history: '1', version: undefined }),
    selectVersion: (version: number) =>
      historyNavigate({ history: '1', version }),
    toggleChanges: () =>
      historyNavigate(
        { changes: search.changes === '1' ? undefined : '1' },
        true,
      ),
  };
}
export function useMemoryPage() {
  const search = useSearch({ from: '/owner/memory' });
  const navigate = useNavigate({ from: '/memory' });
  const queries = useQueryClient();
  const desktop = useDesktop();
  const { bucket, scope, q } = memoryLocation(search);
  const searching = Boolean(q);
  const draft = useQueryDraft(
    q,
    (next) =>
      void navigate({
        search: (previous: MemorySearch) =>
          memorySearch(memoryLocation(previous), { ...previous, q: next }),
        replace: true,
      }),
  );
  const buckets = useBucketList();
  const { busy, results, countsQuery, list, detail } = useMemoryQueries(
    bucket,
    scope,
    q,
    search.memory ?? '',
  );
  const records = list.data?.pages.flatMap((page) => page.memories) ?? [];
  const visible = visibleBuckets(bucket, scope);
  const selected = visibleMemory(detail.data, visible, detail.error);
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
  useAutoSelection(desktop, firstId, search.memory, navigate);
  const history = useHistoryNavigation(search, navigate);
  const forget = useMemoryForget({
    order: forgetOrder(searching, results.data?.results, records),
    desktop,
    memory: search.memory,
    bucket,
    q,
    scope,
  });
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
    busy,
    forget,
    loadMore: () =>
      memoryWriteGate.start(
        queries,
        () => void list.fetchNextPage({ cancelRefetch: false }),
      ),
    retrySearch: () =>
      memoryWriteGate.start(queries, () => void results.refetch()),
    retryCounts: () =>
      memoryWriteGate.start(queries, () => void countsQuery.refetch()),
    retryDetail: () =>
      memoryWriteGate.start(queries, () => void detail.refetch()),
    retryList: () =>
      memoryWriteGate.start(queries, () => {
        void list.refetch();
        if (countsQuery.isError) void countsQuery.refetch();
        if (detail.isError) void detail.refetch();
      }),
    ...history,
    browse: !desktop && !search.bucket,
    detailOpen: !desktop && Boolean(search.memory),
    changeScope: (next: 'bucket' | 'inherited') =>
      void navigate({
        search: memorySearch(
          { bucket, scope: next, q },
          {
            memory: q ? search.memory : undefined,
          },
        ),
        replace: true,
      }),
  };
}
export type MemoryPageModel = ReturnType<typeof useMemoryPage>;
