import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { Effect } from 'effect';
import { useCallback, useSyncExternalStore } from 'react';
import { ApiError, runApi } from './api-client';
import { memoryKeys, memoryOptions } from './memory-api';
import { canLoadMemory } from './memory-cache';

export type DownloadFailure = {
  kind: 'missing' | 'unavailable';
  name: string;
  error: unknown;
  refreshFailed?: boolean;
};

async function saveFile(id: string, name: string) {
  const bytes = await runApi((api) =>
    Effect.flatMap(
      api.memories.downloadFile({
        params: { id, name },
        responseMode: 'decoded-and-response',
      }),
      ([, response]) => response.arrayBuffer,
    ),
  );
  const url = URL.createObjectURL(
    new Blob([bytes], { type: 'application/octet-stream' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  // WebKit may start reading after click returns; keep the URL alive for it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

type DownloadState = {
  pending: string | null;
  failure: DownloadFailure | null;
};
const idle: DownloadState = { pending: null, failure: null };
// Only operation metadata lives here; bytes stay in saveFile. A remounted
// drawer observes pending work and its result. Unobserved idle entries retire.
function downloadRegistry() {
  const states = new Map<string, DownloadState>();
  const listeners = new Map<string, Set<() => void>>();
  const state = (id: string) => states.get(id) ?? idle;
  const retire = (id: string) => {
    if (!listeners.has(id) && state(id).pending === null) states.delete(id);
  };
  return {
    state,
    subscribe(id: string, listener: () => void) {
      const observers = listeners.get(id) ?? new Set();
      listeners.set(id, observers);
      observers.add(listener);
      return () => {
        observers.delete(listener);
        if (!observers.size) listeners.delete(id);
        retire(id);
      };
    },
    update(id: string, patch: Partial<DownloadState>) {
      states.set(id, { ...state(id), ...patch });
      for (const listener of listeners.get(id) ?? []) listener();
      retire(id);
    },
  };
}
const registries = new WeakMap<
  QueryClient,
  ReturnType<typeof downloadRegistry>
>();
function registryFor(queries: QueryClient) {
  let registry = registries.get(queries);
  if (!registry) {
    registry = downloadRegistry();
    registries.set(queries, registry);
  }
  return registry;
}
async function refreshFiles(queries: QueryClient, id: string) {
  const queryKey = memoryKeys.detail(id);
  // An intent preload may have read the file before it was detached. Cancel
  // that read so fetchQuery cannot reuse it as the post-404 refresh.
  await queries.cancelQueries({ queryKey, exact: true });
  if (!canLoadMemory(queries, id) || !queries.getQueryState(queryKey)) return;
  await queries.invalidateQueries({
    queryKey,
    exact: true,
    refetchType: 'none',
  });
  // Recheck after each await: forget cancels reads and removes this detail.
  // fetchQuery's signal keeps the fresh read cancellable by a later forget.
  if (canLoadMemory(queries, id) && queries.getQueryState(queryKey))
    await queries.fetchQuery({ ...memoryOptions(id), staleTime: 0 });
}

export function useFileDownload(id: string) {
  const queries = useQueryClient();
  const registry = registryFor(queries);
  const subscribe = useCallback(
    (listener: () => void) => registry.subscribe(id, listener),
    [registry, id],
  );
  const { pending, failure } = useSyncExternalStore(subscribe, () =>
    registry.state(id),
  );
  const download = async (name: string) => {
    if (registry.state(id).pending !== null) return;
    registry.update(id, { pending: name, failure: null });
    try {
      await saveFile(id, name);
    } catch (error) {
      const missing = error instanceof ApiError && error.status === 404;
      const failure: DownloadFailure = {
        kind: missing ? 'missing' : 'unavailable',
        name,
        error,
      };
      registry.update(id, { failure });
      if (missing) {
        await refreshFiles(queries, id).catch(() => {
          registry.update(id, { failure: { ...failure, refreshFailed: true } });
        });
      }
    } finally {
      registry.update(id, { pending: null });
    }
  };
  return {
    failure,
    pending,
    refreshing: failure?.kind === 'missing' && pending !== null,
    download,
  };
}
