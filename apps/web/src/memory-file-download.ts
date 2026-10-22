import { Effect } from 'effect';
import { useRef, useState } from 'react';
import { ApiError, runApi } from './api-client';
import type { MemoryPageModel } from './use-memory-page';

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

export function useFileDownload(id: string, detail: MemoryPageModel['detail']) {
  const active = useRef(false);
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<DownloadFailure | null>(null);
  const download = async (name: string) => {
    if (active.current) return;
    active.current = true;
    setPending(name);
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
        const result = await detail.refetch();
        if (result.isError) setFailure({ ...failure, refreshFailed: true });
      }
    } finally {
      active.current = false;
      setPending(null);
    }
  };
  return {
    failure,
    pending,
    refreshing: failure?.kind === 'missing' && pending !== null,
    download,
  };
}
