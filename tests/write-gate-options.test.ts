import {
  QueryClient,
  QueryObserver,
  queryOptions,
} from '@tanstack/react-query';
import { expect, it } from 'vitest';
import { createWriteGate } from '../apps/web/src/write-gate.ts';

it.each([true, false])(
  'write gate preserves the caller enabled condition; disableWhileBusy=%s',
  async (disableWhileBusy) => {
    const queries = new QueryClient();
    const gate = createWriteGate(['synthetic-write'], { disableWhileBusy });
    let reads = 0;
    let allowed = false;
    const options = queryOptions({
      queryKey: ['synthetic-read'],
      queryFn: async () => ++reads,
      enabled: (query) => allowed && query.queryKey[0] === 'synthetic-read',
    });
    const observer = new QueryObserver(
      queries,
      gate.queryOptions(options, false, queries),
    );
    const stop = observer.subscribe(() => {});
    try {
      await queries.invalidateQueries();
      expect(reads).toBe(0);
      allowed = true;
      observer.setOptions(gate.queryOptions(options, false, queries));
      await queries.invalidateQueries();
      expect(reads).toBeGreaterThan(0);
      const previous = reads;
      observer.setOptions(
        gate.queryOptions({ ...options, enabled: false }, false, queries),
      );
      await queries.invalidateQueries();
      expect(reads).toBe(previous);
    } finally {
      stop();
      queries.clear();
    }
  },
);
