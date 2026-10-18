import type { MemoryScope } from '@nook/contract';
import {
  type MutationStatus,
  type QueryClient,
  useQueryClient,
} from '@tanstack/react-query';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { ApiError, writeOutcome } from './api-client';
import { memoryOptions, memoryWriteGate, memoryWriteKey } from './memory-api';
import {
  type ForgetRequest,
  type ForgetResult,
  type ForgetSubject,
  type ForgetWrite,
  latestForget,
  refreshChanged,
  useForgetMemory,
} from './memory-forget-api';
import type { MemorySearch } from './memory-location';
import { focusSoon, useConfirmTarget } from './use-confirm-target';

export const memoryRowSelector = (id: string) =>
  `[data-memory-row="${id}"], [data-search-result="${id}"]`;
function shownElement(selector: string) {
  return (
    [...document.querySelectorAll<HTMLElement>(selector)].find(
      (element) => element.getClientRects().length > 0,
    ) ?? null
  );
}
type ForgetUi = {
  neighbor?: string;
  before?: string;
  viewBucket: string;
  query: string;
  scope: MemoryScope;
  inRows: boolean;
};
// Only presentation context lives outside the native mutation lifecycle.
const presentation = new WeakMap<QueryClient, Map<number, ForgetUi>>();
function presentationFor(queries: QueryClient) {
  let entries = presentation.get(queries);
  if (!entries) {
    entries = new Map();
    presentation.set(queries, entries);
  }
  return entries;
}
type ObservedForget = {
  id: number;
  subject: ForgetWrite;
  status: MutationStatus;
  error: Error | null;
  result?: ForgetResult;
};
function entryStatus(write: ObservedForget) {
  if (write.subject.check && write.status !== 'success') return 'unconfirmed';
  if (write.status === 'pending') return 'pending';
  if (write.status === 'success') return write.result;
  if (writeOutcome(write.error) !== 'definitive') return 'unconfirmed';
  return write.error instanceof ApiError && write.error.tag === 'MemoryChanged'
    ? 'changed'
    : 'failed';
}
function adjacent(order: readonly string[], id: string) {
  const index = order.indexOf(id);
  return index < 0 ? undefined : (order[index + 1] ?? order[index - 1]);
}
function forgetState(
  write: ObservedForget | undefined,
  extras: Map<number, ForgetUi>,
) {
  const ui = write && extras.get(write.id);
  if (!write?.subject || !ui) return { entry: null, notice: null };
  const status = entryStatus(write);
  if (status === 'forgotten')
    return {
      entry: null,
      notice: { title: write.subject.title, viewBucket: ui.viewBucket },
    };
  return {
    entry: status
      ? {
          ...ui,
          id: write.id,
          subject: write.subject,
          status,
          error: write.error,
        }
      : null,
    notice: null,
  };
}
function retireForgets(queries: QueryClient, keep?: number) {
  for (const previous of queries
    .getMutationCache()
    .findAll({ mutationKey: memoryWriteKey }))
    if (previous.mutationId !== keep)
      queries.getMutationCache().remove(previous);
}
type ForgetRead = { id: number; pending: boolean; error?: unknown };
function isChecking(
  write: ObservedForget | undefined,
  reading: ForgetRead | null,
) {
  if (!write) return false;
  if (write.subject.check && write.status === 'pending') return true;
  return Boolean(reading?.id === write.id && reading.pending);
}
function shouldRestore(
  pathname: string,
  wasOpen: boolean,
  desktop: boolean,
  current: string | undefined,
  neighbor: string | undefined,
) {
  return pathname === '/memory' && wasOpen && desktop && current === neighbor;
}
export function useMemoryForget({
  order,
  desktop,
  memory,
  bucket,
  q,
  scope,
}: {
  order: readonly string[];
  desktop: boolean;
  memory?: string;
  bucket: string;
  q: string;
  scope: MemoryScope;
}) {
  const queries = useQueryClient();
  const navigate = useNavigate({ from: '/memory' });
  const router = useRouter();
  const mutation = useForgetMemory();
  const confirmation = useConfirmTarget<ForgetSubject>(() =>
    shownElement('[data-memory-list-heading]'),
  );
  const extras = presentationFor(queries);
  const { write } = memoryWriteGate.useWrites<ObservedForget>((mutation) => ({
    id: mutation.mutationId,
    subject: mutation.state.variables as ForgetWrite,
    status: mutation.state.status,
    error: mutation.state.error,
    result: mutation.state.data as ForgetResult | undefined,
  }));
  const { entry, notice } = forgetState(write, extras);
  const [reading, setReading] = useState<ForgetRead | null>(null);
  const isLatest = (id: number) => latestForget(queries)?.mutationId === id;
  const select = (id?: string) =>
    void navigate({
      to: '/memory',
      search: (previous: MemorySearch) => ({
        ...previous,
        memory: id,
        history: undefined,
        version: undefined,
        changes: undefined,
      }),
      replace: true,
    });
  const submit = (subject: ForgetRequest, ui: ForgetUi, check?: true) => {
    const result = mutation.mutateAsync({ ...subject, check });
    const token = latestForget(queries)?.mutationId;
    if (token === undefined) throw new Error('Missing forget mutation');
    extras.clear();
    const { neighbor, before, viewBucket, query, scope, inRows } = ui;
    extras.set(token, { neighbor, before, viewBucket, query, scope, inRows });
    retireForgets(queries, token);
    return { result, token };
  };
  const run = async (subject: ForgetRequest) => {
    if (memoryWriteGate.isWriting(queries)) return;
    const neighbor = adjacent(order, subject.id);
    const wasOpen = memory === subject.id;
    const focusTarget = () =>
      (neighbor ? shownElement(memoryRowSelector(neighbor)) : null) ??
      shownElement('[data-memory-list-heading]');
    confirmation.close(focusTarget);
    if (wasOpen) select(desktop ? neighbor : undefined);
    const { result, token } = submit(subject, {
      neighbor,
      before: order[order.indexOf(subject.id) + 1],
      viewBucket: bucket,
      query: q,
      scope,
      inRows: order.includes(subject.id),
    });
    try {
      await result;
    } catch (error) {
      if (!isLatest(token) || writeOutcome(error) !== 'definitive') return;
      const location = router.latestLocation;
      const current = (location.search as MemorySearch).memory;
      if (shouldRestore(location.pathname, wasOpen, desktop, current, neighbor))
        select(subject.id);
    }
  };
  const checking = isChecking(write, reading);
  return {
    ...confirmation,
    entry,
    notice,
    checking,
    readFailure: reading?.id === write?.id ? reading?.error : undefined,
    dismissReadFailure: () => setReading(null),
    refreshCurrent: async () => {
      if (!entry || checking || memoryWriteGate.isWriting(queries)) return;
      const token = entry.id;
      setReading({ id: token, pending: true });
      try {
        await refreshChanged(queries, entry.subject.id);
        if (isLatest(token)) setReading(null);
      } catch (error) {
        if (isLatest(token)) setReading({ id: token, pending: false, error });
      }
    },
    check: async () => {
      if (!entry || checking || memoryWriteGate.isWriting(queries)) return;
      const { result, token } = submit(entry.subject, entry, true);
      try {
        await result;
      } catch (error) {
        if (isLatest(token)) setReading({ id: token, pending: false, error });
      }
    },
    open: (subject: ForgetSubject, from: HTMLElement | null) => {
      if (!memoryWriteGate.isWriting(queries)) confirmation.open(subject, from);
    },
    cancel: () => confirmation.close(),
    confirm: (version: number) => {
      if (confirmation.target) void run({ ...confirmation.target, version });
    },
    retry: () => {
      if (entry) {
        void run(entry.subject);
        focusSoon(
          () =>
            shownElement(memoryRowSelector(entry.neighbor ?? '')) ??
            shownElement('[data-memory-list-heading]'),
        );
      }
    },
    keep: () => {
      if (!write || !isLatest(write.id)) return;
      retireForgets(queries);
      extras.clear();
      if (entry)
        focusSoon(() => shownElement(memoryRowSelector(entry.subject.id)));
    },
    current: entry
      ? queries.getQueryData(memoryOptions(entry.subject.id).queryKey)
      : undefined,
  };
}
