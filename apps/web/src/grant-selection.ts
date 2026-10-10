import { type BucketGrant, normalizeGrant } from '@nook/contract';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { refreshBucketList, useBucketList } from './buckets-api';

export function useGrantSelection() {
  const queries = useQueryClient();
  const buckets = useBucketList();
  const [roots, setRoots] = useState<readonly string[]>(['me']);
  const [all, setAll] = useState(false);
  const [error, setError] = useState<string>();
  const grant: BucketGrant = all ? 'all' : roots;
  const ready = all || (buckets.isSuccess && !buckets.isFetching);
  const change = (value: readonly string[]) => {
    const normalized = normalizeGrant(value);
    if (normalized !== 'all') setRoots(normalized);
    setError(undefined);
  };
  const refresh = async () => {
    try {
      const current = await refreshBucketList(queries);
      const existing = new Set(current.map((bucket) => bucket.path));
      setRoots((chosen) => chosen.filter((path) => existing.has(path)));
    } catch {
      /* The list presents its own retry and keeps the remaining choices. */
    }
  };
  return {
    buckets,
    roots,
    all,
    grant,
    ready,
    error,
    retry: refresh,
    toggleAll: (value: boolean) => {
      setAll(value);
      setError(undefined);
    },
    toggle: (path: string) =>
      change(
        roots.includes(path)
          ? roots.filter((root) => root !== path)
          : [...roots, path],
      ),
    validate: () => {
      if (!ready) return false;
      const valid = all || roots.length > 0;
      setError(valid ? undefined : 'Choose at least one bucket.');
      return valid;
    },
    reset: () => {
      setAll(false);
      change(['me']);
    },
    missing: async () => {
      setError('Some selected buckets no longer exist. Choose again.');
      await refresh();
    },
  };
}
export type GrantSelection = ReturnType<typeof useGrantSelection>;
