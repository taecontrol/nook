import { bucketLineage, validateBucketPath } from '@nook/contract';
export type Bucket = { path: string; createdAt: string };

export const RESERVED = 'me';

export type PathProblem =
  | { kind: 'uppercase'; message: string; suggestion: string }
  | { kind: 'other'; message: string };
export function validatePath(path: string): PathProblem | null {
  const message = validateBucketPath(path);
  if (!message) return null;
  if (/[A-Z]/.test(path))
    return { kind: 'uppercase', message, suggestion: path.toLowerCase() };
  return { kind: 'other', message };
}

/** Every prefix of a path, from the top level down to the path itself. */
export const lineage = bucketLineage;

export function parentOf(path: string): string | null {
  const index = path.lastIndexOf('/');
  return index === -1 ? null : path.slice(0, index);
}

export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export type CreatePlan = {
  path: string;
  /** Paths that do not exist yet, top level first; empty when the path exists. */
  missing: string[];
  /** Deepest existing ancestor, where the new buckets land. */
  landsIn: string | null;
};

export function planCreate(path: string, existing: Set<string>): CreatePlan {
  const prefixes = lineage(path);
  const missing = prefixes.filter((prefix) => !existing.has(prefix));
  const landsIn =
    [...prefixes]
      .reverse()
      .find((prefix) => existing.has(prefix) && prefix !== path) ?? null;
  return { path, missing, landsIn };
}

export function hasChildren(path: string, buckets: Bucket[]): boolean {
  return buckets.some((bucket) => bucket.path.startsWith(`${path}/`));
}

export function sortBuckets(buckets: Bucket[]): Bucket[] {
  return [...buckets].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

const dateFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

export function formatDate(iso: string): string {
  return dateFormat.format(new Date(iso));
}
