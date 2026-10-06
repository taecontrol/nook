import { Schema } from 'effect';
import { BucketPath, bucketLineage } from './buckets.ts';

export const BucketGrant = Schema.Union([
  Schema.Literal('all'),
  Schema.Array(BucketPath).check(Schema.isMinLength(1)),
]);
export type BucketGrant = typeof BucketGrant.Type;

function inside(path: string, root: string) {
  return path === root || path.startsWith(`${root}/`);
}
export function canRead(grant: BucketGrant, path: string): boolean {
  return (
    grant === 'all' ||
    path === 'me' ||
    grant.some((root) => inside(path, root) || inside(root, path))
  );
}
export function canWrite(grant: BucketGrant, path: string): boolean {
  return grant === 'all' || grant.some((root) => inside(path, root));
}
export function normalizeGrant(grant: BucketGrant): BucketGrant {
  if (grant === 'all') return grant;
  const roots = [...new Set(grant)].sort();
  return roots.filter(
    (path) => !roots.some((root) => path !== root && inside(path, root)),
  );
}
export function readOnlyBuckets(grant: BucketGrant): string[] {
  if (grant === 'all') return [];
  const readable = new Set([
    'me',
    ...grant.flatMap((path) => bucketLineage(path).slice(0, -1)),
  ]);
  return [...readable].filter((path) => !canWrite(grant, path)).sort();
}
export function readOnlyText(grant: BucketGrant) {
  return `Read only: ${readOnlyBuckets(grant).join(', ') || 'none'}`;
}
export const limitedAccessText =
  'read/write, including current and future descendants';
export class InvalidBucketGrant extends Schema.Error<InvalidBucketGrant>(
  'nook/InvalidBucketGrant',
)(
  { _tag: Schema.tag('InvalidBucketGrant'), message: Schema.String },
  { httpApiStatus: 400 },
) {}
export class GrantBucketNotFound extends Schema.Error<GrantBucketNotFound>(
  'nook/GrantBucketNotFound',
)(
  { _tag: Schema.tag('GrantBucketNotFound'), message: Schema.String },
  { httpApiStatus: 400 },
) {}
