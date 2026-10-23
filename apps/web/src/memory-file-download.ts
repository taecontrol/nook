import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { Effect } from 'effect';
import { useState, useSyncExternalStore } from 'react';
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
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Only pending filenames survive drawer/route unmounts. Bytes stay in saveFile,
// and settled operations leave this QueryClient-scoped registry immediately.
function pendingRegistry() {
  const pending = new Map<string, string>();
  const listeners = new Set<() => void>();
  return {
    pending,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(id: string, name: string | null) {
      if (name === null) pending.delete(id);
      else pending.set(id, name);
      for (const listener of listeners) listener();
    },
  };
}
const registries = new WeakMap<
  QueryClient,
  ReturnType<typeof pendingRegistry>
>();
function registryFor(queries: QueryClient) {
  let registry = registries.get(queries);
  if (!registry) {
    registry = pendingRegistry();
    registries.set(queries, registry);
  }
  return registry;
}
async function refreshFiles(queries: QueryClient, id: string) {
  const queryKey = memoryKeys.detail(id);
  await queries.invalidateQueries({
    queryKey,
    exact: true,
    refetchType: 'none',
  });
  // Forget cancels reads and removes this detail. Do not recreate it or read
  // across its pending write; the ordinary detail query resumes when safe.
  if (canLoadMemory(queries, id) && queries.getQueryState(queryKey))
    await queries.fetchQuery({ ...memoryOptions(id), staleTime: 0 });
}

export function useFileDownload(id: string) {
  const queries = useQueryClient();
  const registry = registryFor(queries);
  const pending = useSyncExternalStore(
    registry.subscribe,
    () => registry.pending.get(id) ?? null,
  );
  const [failure, setFailure] = useState<DownloadFailure | null>(null);
  const download = async (name: string) => {
    if (registry.pending.has(id)) return;
    registry.update(id, name);
    setFailure(null);
    try {
      await saveFile(id, name);
    } catch (error) {
      const missing = error instanceof ApiError && error.status === 404;
      const failure: DownloadFailure = {
        kind: missing ? 'missing' : 'unavailable',
        name,
        error,
      };
      setFailure(failure);
      if (missing) {
        await refreshFiles(queries, id).catch(() => {
          setFailure({ ...failure, refreshFailed: true });
        });
      }
    } finally {
      registry.update(id, null);
    }
  };
  return {
    failure,
    pending,
    refreshing: failure?.kind === 'missing' && pending !== null,
    download,
  };
}
