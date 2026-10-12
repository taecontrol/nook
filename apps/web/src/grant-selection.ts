import {
  type BucketGrant,
  normalizeGrant,
  RESERVED_BUCKET,
} from '@nook/contract';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { refreshBucketList, useBucketList } from './buckets-api';

export function useGrantSelection(initial: BucketGrant = [RESERVED_BUCKET]) {
  const queries = useQueryClient();
  const buckets = useBucketList();
  const [roots, setRoots] = useState<readonly string[]>(
    initial === 'all' ? [] : initial,
  );
  const [all, setAll] = useState(initial === 'all');
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string>();
  const grant: BucketGrant = all ? 'all' : roots;
  const ready = all || (buckets.isSuccess && !buckets.isFetching);
  const change = (value: readonly string[]) => {
    const normalized = normalizeGrant(value);
    if (normalized !== 'all') setRoots(normalized);
    setError(undefined);
    setRevision((value) => value + 1);
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
    revision,
    retry: refresh,
    toggleAll: (value: boolean) => {
      setAll(value);
      setError(undefined);
      setRevision((value) => value + 1);
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
      change([RESERVED_BUCKET]);
    },
    missing: async () => {
      setError('Some selected buckets no longer exist. Choose again.');
      await refresh();
    },
  };
}
export type GrantSelection = ReturnType<typeof useGrantSelection>;
