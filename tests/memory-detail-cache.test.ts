import type { Memory } from '@nook/contract';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import * as api from '../apps/web/src/api-client.ts';
import { memoryOptions } from '../apps/web/src/memory-api.ts';
import { writeMemory } from '../apps/web/src/memory-cache.ts';

it('a detail fetch publishes only its completed result and retains a newer cached version', async () => {
  const memory: Memory = {
    id: '00000000-0000-4000-8000-000000000001',
    bucket: 'me',
    content: 'Synthetic memory',
    tags: [],
    version: 1,
    createdAt: '2026-10-13T15:00:00Z',
    updatedAt: '2026-10-13T15:00:00Z',
    provenance: {
      client: { name: 'synthetic-client', version: null },
      principal: { kind: 'owner' },
      workingDirectory: null,
      at: '2026-10-13T15:00:00Z',
    },
  };
  const read = vi.spyOn(api, 'runApi').mockResolvedValue(memory);
  const queries = new QueryClient();
  const options = memoryOptions(memory.id);
  const states: string[] = [];
  const observer = new QueryObserver(queries, options);
  const unsubscribe = observer.subscribe((result) =>
    states.push(`${result.status}/${result.fetchStatus}`),
  );
  try {
    expect(await queries.fetchQuery(options)).toEqual(memory);
    expect(states).toEqual(['pending/fetching', 'success/idle']);
    const newer = { ...memory, version: 2, content: 'Newer content' };
    writeMemory(queries, newer);
    expect(await queries.fetchQuery({ ...options, staleTime: 0 })).toEqual(
      newer,
    );
  } finally {
    unsubscribe();
    queries.clear();
    read.mockRestore();
  }
});
