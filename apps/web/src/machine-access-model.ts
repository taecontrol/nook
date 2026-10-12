import { type BucketGrant, canRead, canWrite } from '@nook/contract';

export type AccessChange = {
  kind: 'add' | 'remove' | 'keep';
  label: string;
  path: boolean;
  effect: string;
};
export function existingGrant(grant: BucketGrant, existing: Set<string>) {
  return grant === 'all' ? grant : grant.filter((path) => existing.has(path));
}
export function missingRoots(grant: BucketGrant, existing: Set<string>) {
  return grant === 'all' ? [] : grant.filter((path) => !existing.has(path));
}
export function accessChanges(
  before: BucketGrant,
  after: BucketGrant,
  missing: readonly string[],
): AccessChange[] {
  const gone = missing.map((label) => ({
    kind: 'remove' as const,
    label,
    path: true,
    effect: 'No longer exists',
  }));
  if (after === 'all')
    return before === 'all'
      ? []
      : [
          {
            kind: 'add',
            label: 'All buckets',
            path: false,
            effect: 'Every current and future bucket',
          },
          ...gone,
        ];
  if (before === 'all')
    return [
      {
        kind: 'remove',
        label: 'All buckets',
        path: false,
        effect: 'Other buckets become read only or hidden',
      },
      ...after.map((label) => ({
        kind: 'keep' as const,
        label,
        path: true,
        effect: 'Keeps read and write',
      })),
    ];
  const added = after
    .filter((path) => !canWrite(before, path))
    .map((label) => ({
      kind: 'add' as const,
      label,
      path: true,
      effect: 'Read and write',
    }));
  const removed = before
    .filter((path) => !missing.includes(path) && !canWrite(after, path))
    .map((label) => ({
      kind: 'remove' as const,
      label,
      path: true,
      effect: canRead(after, label) ? 'Becomes read only' : 'Becomes hidden',
    }));
  return [...added, ...removed, ...gone];
}
