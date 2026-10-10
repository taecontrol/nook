import { Schema } from 'effect';
import { validateBucketPath } from './buckets.ts';

export const memoryLimits = {
  contentBytes: 16 * 1024,
  tags: 10,
  tagCharacters: 32,
  titleCharacters: 120,
} as const;
export function validateMemoryContent(content: string): string | undefined {
  if (!content.trim()) return 'Enter memory content.';
  if (content.includes('\0')) return 'Memory content cannot contain NUL.';
  if (/[\uD800-\uDFFF]/u.test(content))
    return 'Use valid Unicode for the content.';
  if (new TextEncoder().encode(content).length > memoryLimits.contentBytes)
    return 'Memory content can be at most 16 KiB.';
}
export function validateTags(tags: readonly string[]): string | undefined {
  if (tags.length > memoryLimits.tags)
    return 'A memory can have at most 10 tags.';
  if (new Set(tags).size !== tags.length) return 'Use each tag only once.';
  for (const tag of tags) {
    if (tag.includes('/'))
      return 'Use lowercase letters, digits, and single hyphens in each tag.';
    const message = validateBucketPath(tag);
    if (message) return message;
  }
}
export function memoryTitle(content: string) {
  const line = content.split(/\r?\n/).find((value) => value.trim()) ?? '';
  const title = line
    .trim()
    .replace(/^(?:[#>*-]+\s*)+/, '')
    .trim();
  return Array.from(title || 'Untitled memory')
    .slice(0, memoryLimits.titleCharacters)
    .join('');
}
export const MemoryId = Schema.String.check(Schema.isUUID(4));
export const Principal = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('owner') }),
  Schema.Struct({
    kind: Schema.Literal('machine'),
    id: Schema.String,
    name: Schema.String,
  }),
]);
export type Principal = typeof Principal.Type;
export const MemoryClient = Schema.Struct({
  name: Schema.String,
  version: Schema.NullOr(Schema.String),
});
export type MemoryClient = typeof MemoryClient.Type;
export const Provenance = Schema.Struct({
  client: MemoryClient,
  principal: Principal,
  workingDirectory: Schema.NullOr(Schema.String),
  at: Schema.String,
});
export type Provenance = typeof Provenance.Type;
export const Remember = Schema.Struct({
  bucket: Schema.String,
  content: Schema.String,
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
  workingDirectory: Schema.optionalKey(Schema.String),
});
export type Remember = typeof Remember.Type;
export const Remembered = Schema.Struct({
  created: Schema.Boolean,
  id: MemoryId,
  bucket: Schema.String,
  version: Schema.Number,
  tags: Schema.Array(Schema.String),
  createdAt: Schema.String,
});
export type Remembered = typeof Remembered.Type;
export const Memory = Schema.Struct({
  id: MemoryId,
  bucket: Schema.String,
  content: Schema.String,
  tags: Schema.Array(Schema.String),
  version: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  provenance: Provenance,
});
export type Memory = typeof Memory.Type;
export const MemoryListItem = Memory.mapFields(({ content: _, ...fields }) => ({
  ...fields,
  title: Schema.String,
}));
export type MemoryListItem = typeof MemoryListItem.Type;
export const MemoryPage = Schema.Struct({
  memories: Schema.Array(MemoryListItem),
  next: Schema.NullOr(Schema.String),
});
export const MemoryScope = Schema.Literals(['bucket', 'inherited']);
export type MemoryScope = typeof MemoryScope.Type;
export const MemoryQuery = Schema.Struct({
  bucket: Schema.String,
  scope: Schema.optionalKey(MemoryScope),
  cursor: Schema.optionalKey(Schema.String),
});
export const MemoryCounts = Schema.Struct({
  counts: Schema.Array(
    Schema.Struct({ bucket: Schema.String, count: Schema.Number }),
  ),
});
export class InvalidMemory extends Schema.Error<InvalidMemory>(
  'nook/InvalidMemory',
)(
  { _tag: Schema.tag('InvalidMemory'), message: Schema.String },
  { httpApiStatus: 400 },
) {}
export class MemoryNotFound extends Schema.Error<MemoryNotFound>(
  'nook/MemoryNotFound',
)(
  { _tag: Schema.tag('MemoryNotFound'), message: Schema.String },
  { httpApiStatus: 404 },
) {}
export class BucketHasMemories extends Schema.Error<BucketHasMemories>(
  'nook/BucketHasMemories',
)(
  { _tag: Schema.tag('BucketHasMemories'), message: Schema.String },
  { httpApiStatus: 409 },
) {}
export class InvalidMemoryCursor extends Schema.Error<InvalidMemoryCursor>(
  'nook/InvalidMemoryCursor',
)({ _tag: Schema.tag('InvalidMemoryCursor') }, { httpApiStatus: 400 }) {}
