import type { OwnerMemory } from '@nook/contract';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import * as api from '../apps/web/src/api-client.ts';
import { memoryOptions, memoryWriteKey } from '../apps/web/src/memory-api.ts';
import { canLoadMemory, writeMemory } from '../apps/web/src/memory-cache.ts';
import { deferred } from './support/machines.ts';

it('a detail fetch publishes only its completed result and retains a newer cached version', async () => {
  const memory: OwnerMemory = {
    id: '00000000-0000-4000-8000-000000000001',
    bucket: 'me',
    content: 'Synthetic memory',
    tags: [],
    files: [],
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

it('outcome checks do not block detail reads while a newer forget blocks only its own memory', async () => {
  const queries = new QueryClient();
  const checking = deferred();
  const forgetting = deferred();
  const check = queries
    .getMutationCache()
    .build(queries, {
      mutationKey: memoryWriteKey,
      mutationFn: (_input: { id: string; check: true }) => checking.promise,
    })
    .execute({ id: 'checked-memory', check: true });
  const forget = queries
    .getMutationCache()
    .build(queries, {
      mutationKey: memoryWriteKey,
      mutationFn: (_input: { id: string }) => forgetting.promise,
    })
    .execute({ id: 'forgotten-memory' });
  try {
    expect(queries.isMutating({ mutationKey: memoryWriteKey })).toBe(2);
    expect(canLoadMemory(queries, 'checked-memory')).toBe(true);
    expect(canLoadMemory(queries, 'forgotten-memory')).toBe(false);
    expect(canLoadMemory(queries, 'another-memory')).toBe(true);
    expect(canLoadMemory(queries, '')).toBe(false);
  } finally {
    checking.resolve();
    forgetting.resolve();
    await Promise.all([check, forget]);
    queries.clear();
  }
});
