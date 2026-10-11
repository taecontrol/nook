import { Schema } from 'effect';

export const RESERVED_BUCKET = 'me';

export const bucketPathMessages = {
  empty: 'Enter a bucket path.',
  characters:
    'Use lowercase letters, digits, and single hyphens in each segment.',
  separators:
    'Separate segments with a single /, with none at the start or end.',
  segmentLength: 'Each segment can have at most 32 characters.',
  depth: 'A bucket path can have at most 6 levels.',
};
export function validateBucketPath(path: string): string | undefined {
  if (path === '') return bucketPathMessages.empty;
  if (/[A-Z]/.test(path)) return `Use lowercase letters: ${path.toLowerCase()}`;
  if (/(^\/|\/$|\/\/)/.test(path)) return bucketPathMessages.separators;
  const segments = path.split('/');
  if (segments.some((segment) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segment)))
    return bucketPathMessages.characters;
  if (segments.some((segment) => segment.length > 32))
    return bucketPathMessages.segmentLength;
  if (segments.length > 6) return bucketPathMessages.depth;
}
export const BucketPath = Schema.String.check(
  Schema.makeFilter(validateBucketPath),
);
export const Bucket = Schema.Struct({
  path: BucketPath,
  createdAt: Schema.String,
});
export type Bucket = typeof Bucket.Type;
export const CreatedBucket = Schema.Struct({
  path: BucketPath,
  created: Schema.Boolean,
  createdAncestors: Schema.Array(BucketPath),
});
export type CreatedBucket = typeof CreatedBucket.Type;
export function bucketLineage(path: string): string[] {
  return path
    .split('/')
    .map((_, index, segments) => segments.slice(0, index + 1).join('/'));
}
export function readLineage(bucket: string) {
  const paths = bucketLineage(bucket).reverse();
  return paths.includes(RESERVED_BUCKET) ? paths : [...paths, RESERVED_BUCKET];
}
export class InvalidBucketPath extends Schema.Error<InvalidBucketPath>(
  'nook/InvalidBucketPath',
)(
  { _tag: Schema.tag('InvalidBucketPath'), message: Schema.String },
  { httpApiStatus: 400 },
) {}
export class ReservedBucket extends Schema.Error<ReservedBucket>(
  'nook/ReservedBucket',
)(
  { _tag: Schema.tag('ReservedBucket'), message: Schema.String },
  { httpApiStatus: 400 },
) {}
export class BucketHasChildren extends Schema.Error<BucketHasChildren>(
  'nook/BucketHasChildren',
)(
  { _tag: Schema.tag('BucketHasChildren'), message: Schema.String },
  { httpApiStatus: 409 },
) {}
export class BucketNotFound extends Schema.Error<BucketNotFound>(
  'nook/BucketNotFound',
)(
  { _tag: Schema.tag('BucketNotFound'), message: Schema.String },
  { httpApiStatus: 404 },
) {}
