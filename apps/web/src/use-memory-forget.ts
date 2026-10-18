import type { MemoryScope } from '@nook/contract';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { ApiError } from './api-client';
import {
  invalidateMemoryLists,
  memoryOptions,
  memoryWriteGate,
  writeMemory,
} from './memory-api';
import {
  type ForgetRequest,
  type ForgetSubject,
  readForgetOutcome,
  refreshChanged,
  useForgetMemory,
} from './memory-forget-api';
import type { MemorySearch } from './memory-location';
import { useLastValue } from './use-confirm-target';

export const memoryRowSelector = (id: string) =>
  `[data-memory-row="${id}"], [data-search-result="${id}"]`;
function shownElement(selector: string) {
  return (
    [...document.querySelectorAll<HTMLElement>(selector)].find(
      (element) => element.getClientRects().length > 0,
    ) ?? null
  );
}
function focusSoon(find: () => HTMLElement | null) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => find()?.focus({ preventScroll: true })),
  );
}
type ForgetEntry = {
  subject: ForgetRequest;
  status: 'pending' | 'failed' | 'changed' | 'unconfirmed';
  error?: unknown;
  neighbor?: string;
  before?: string;
  viewBucket: string;
  query: string;
  scope: MemoryScope;
  inRows: boolean;
};
function adjacent(order: readonly string[], id: string) {
  const index = order.indexOf(id);
  return index < 0 ? undefined : (order[index + 1] ?? order[index - 1]);
}
function failureStatus(error: unknown) {
  if (error instanceof ApiError && error.ambiguous)
    return 'unconfirmed' as const;
  return error instanceof ApiError && error.tag === 'MemoryChanged'
    ? ('changed' as const)
    : ('failed' as const);
}
function shouldRestore(
  wasOpen: boolean,
  desktop: boolean,
  current: string | undefined,
  neighbor: string | undefined,
) {
  return wasOpen && desktop && current === neighbor;
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
  const [target, setTarget] = useState<ForgetSubject | null>(null);
  const shown = useLastValue(target);
  const [entry, setEntry] = useState<ForgetEntry | null>(null);
  const operation = useRef(0);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<{
    title: string;
    viewBucket: string;
  } | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const after = useRef<(() => HTMLElement | null) | null>(null);
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
  const open = (subject: ForgetSubject, from: HTMLElement | null) => {
    if (memoryWriteGate.isWriting(queries)) return;
    trigger.current = from;
    after.current = null;
    setTarget(subject);
  };
  const run = async (subject: ForgetRequest) => {
    if (memoryWriteGate.isWriting(queries)) return;
    operation.current++;
    const neighbor = adjacent(order, subject.id);
    const wasOpen = memory === subject.id;
    const focusTarget = () =>
      (neighbor ? shownElement(memoryRowSelector(neighbor)) : null) ??
      shownElement('[data-memory-list-heading]');
    setNotice(null);
    setEntry({
      subject,
      status: 'pending',
      neighbor,
      before: order[order.indexOf(subject.id) + 1],
      viewBucket: bucket,
      query: q,
      scope,
      inRows: order.includes(subject.id),
    });
    after.current = focusTarget;
    if (wasOpen) select(desktop ? neighbor : undefined);
    try {
      await mutation.mutateAsync(subject);
      setEntry(null);
      setNotice({ title: subject.title, viewBucket: bucket });
    } catch (error) {
      setEntry({
        subject,
        status: failureStatus(error),
        error,
        neighbor,
        viewBucket: bucket,
        query: q,
        scope,
        inRows: order.includes(subject.id),
      });
      const current = (router.latestLocation.search as MemorySearch).memory;
      if (
        failureStatus(error) !== 'unconfirmed' &&
        router.latestLocation.pathname === '/memory' &&
        shouldRestore(wasOpen, desktop, current, neighbor)
      )
        select(subject.id);
    }
  };
  return {
    target,
    shown,
    entry,
    notice,
    checking,
    refreshCurrent: async () => {
      if (!entry || checking) return;
      setChecking(true);
      try {
        await refreshChanged(queries, entry.subject.id);
      } catch {
      } finally {
        setChecking(false);
      }
    },
    check: async () => {
      if (!entry || checking) return;
      const checkedOperation = operation.current;
      setChecking(true);
      try {
        const current = await readForgetOutcome(entry.subject.id);
        if (operation.current !== checkedOperation) return;
        if (current) {
          writeMemory(queries, current);
          setEntry({
            ...entry,
            status:
              current.version === entry.subject.version ? 'failed' : 'changed',
          });
          await invalidateMemoryLists(queries);
        } else {
          setEntry(null);
          setNotice({
            title: entry.subject.title,
            viewBucket: entry.viewBucket,
          });
        }
      } catch {
      } finally {
        setChecking(false);
      }
    },
    open,
    cancel: () => setTarget(null),
    confirm: (version: number) => {
      if (target) {
        setTarget(null);
        void run({ ...target, version });
      }
    },
    retry: () => {
      if (entry) {
        void run(entry.subject);
        if (after.current) focusSoon(after.current);
      }
    },
    keep: () => {
      operation.current++;
      const id = entry?.subject.id;
      setEntry(null);
      if (id) focusSoon(() => shownElement(memoryRowSelector(id)));
    },
    current: entry
      ? queries.getQueryData(memoryOptions(entry.subject.id).queryKey)
      : undefined,
    restoreFocus: (event: Event) => {
      event.preventDefault();
      const next = after.current;
      after.current = null;
      if (next) focusSoon(next);
      else if (trigger.current?.isConnected)
        trigger.current.focus({ preventScroll: true });
      else focusSoon(() => shownElement('[data-memory-list-heading]'));
    },
  };
}
