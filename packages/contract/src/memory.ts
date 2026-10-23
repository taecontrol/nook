import { Schema } from 'effect';
import { validateBucketPath } from './buckets.ts';
import { BucketScope } from './grants.ts';
import { MemoryFile, OwnerMemoryFile } from './memory-files.ts';
import { Provenance } from './provenance.ts';

export { MemoryClient, Principal, Provenance } from './provenance.ts';

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
  const line = content.split(/\r\n?|\n/).find((value) => value.trim()) ?? '';
  const title = line
    .trim()
    .replace(/^(?:[#>*-]+\s*)+/, '')
    .trim();
  return Array.from(title || 'Untitled memory')
    .slice(0, memoryLimits.titleCharacters)
    .join('');
}
export const MemoryId = Schema.String.check(Schema.isUUID(4));
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
export const ExpectedVersion = Schema.Number.check(
  Schema.isFinite(),
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
);
export const UpdateMemory = Schema.Struct({
  id: Schema.String,
  expectedVersion: ExpectedVersion,
  content: Schema.String,
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
  workingDirectory: Schema.optionalKey(Schema.String),
});
export type UpdateMemory = typeof UpdateMemory.Type;
export const ForgetMemory = Schema.Struct({
  id: Schema.String,
  expectedVersion: ExpectedVersion,
});
export type ForgetMemory = typeof ForgetMemory.Type;
export const Forgotten = Schema.Struct({
  id: MemoryId,
  bucket: Schema.String,
  version: Schema.Number,
});
export type Forgotten = typeof Forgotten.Type;
const isExpectedVersion = Schema.is(ExpectedVersion);
export function validateExpectedVersion(version: unknown): string | undefined {
  if (!isExpectedVersion(version))
    return 'Use a positive integer for expectedVersion.';
}
export const Updated = Remembered.mapFields(({ created: _, ...fields }) => ({
  ...fields,
  updated: Schema.Boolean,
  updatedAt: Schema.String,
}));
export type Updated = typeof Updated.Type;
export const MemoryVersion = Schema.Struct({
  version: Schema.Number,
  content: Schema.String,
  tags: Schema.Array(Schema.String),
  provenance: Provenance,
});
export type MemoryVersion = typeof MemoryVersion.Type;
export const MemoryHistory = Schema.Struct({
  versions: Schema.Array(MemoryVersion),
  next: Schema.NullOr(Schema.Number),
});
export const MemoryHistoryQuery = Schema.Struct({
  before: Schema.optionalKey(Schema.String),
});
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
export const OwnerMemory = Memory.mapFields((fields) => ({
  ...fields,
  files: Schema.Array(OwnerMemoryFile),
}));
export type OwnerMemory = typeof OwnerMemory.Type;
export const McpMemory = Memory.mapFields((fields) => ({
  ...fields,
  files: Schema.Array(MemoryFile),
}));
export const MemoryListItem = Memory.mapFields(({ content: _, ...fields }) => ({
  ...fields,
  title: Schema.String,
}));
export type MemoryListItem = typeof MemoryListItem.Type;
export const MemoryPage = Schema.Struct({
  memories: Schema.Array(MemoryListItem),
  next: Schema.NullOr(Schema.String),
});
export const MemoryScope = BucketScope;
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
export const SearchMemories = Schema.Struct({
  bucket: Schema.String,
  query: Schema.String,
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
});
export const MemoryMatch = Schema.Literals(['keyword', 'meaning', 'both']);
export const MemorySearchResult = Schema.Struct({
  id: MemoryId,
  bucket: Schema.String,
  title: Schema.String,
  tags: Schema.Array(Schema.String),
  snippet: Schema.String,
  match: MemoryMatch,
});
export type MemorySearchResult = typeof MemorySearchResult.Type;
export const McpMemorySearchResult = MemorySearchResult.mapFields((fields) => ({
  ...fields,
  files: Schema.Array(
    Schema.Struct({ name: Schema.String, size: Schema.Number }),
  ),
  fileCount: Schema.Number,
}));
export type McpMemorySearchResult = typeof McpMemorySearchResult.Type;
export const MeaningAvailability = Schema.Literals([
  'available',
  'unavailable',
]);
export const MemorySearchResults = Schema.Struct({
  results: Schema.Array(McpMemorySearchResult),
  meaning: MeaningAvailability,
});
export const OwnerMemorySearchResult = MemorySearchResult.mapFields(
  (fields) => ({
    ...fields,
    highlights: Schema.Array(Schema.Tuple([Schema.Number, Schema.Number])),
    createdAt: Schema.String,
    provenance: Provenance,
  }),
);
export type OwnerMemorySearchResult = typeof OwnerMemorySearchResult.Type;
export const OwnerMemorySearchResults = Schema.Struct({
  results: Schema.Array(OwnerMemorySearchResult),
  meaning: MeaningAvailability,
});
export const MemorySearchQuery = Schema.Struct({
  bucket: Schema.String,
  scope: Schema.optionalKey(MemoryScope),
  q: Schema.String,
});
export function validateSearchQuery(query: string): string | undefined {
  if (!query.trim()) return 'Enter a search query.';
  if (Array.from(query).length > 512)
    return 'A search query can be at most 512 characters.';
}
export class InvalidMemorySearch extends Schema.Error<InvalidMemorySearch>(
  'nook/InvalidMemorySearch',
)(
  { _tag: Schema.tag('InvalidMemorySearch'), message: Schema.String },
  { httpApiStatus: 400 },
) {}
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
export class MemoryChanged extends Schema.Error<MemoryChanged>(
  'nook/MemoryChanged',
)(
  { _tag: Schema.tag('MemoryChanged'), message: Schema.String },
  { httpApiStatus: 409 },
) {}
export class DuplicateMemory extends Schema.Error<DuplicateMemory>(
  'nook/DuplicateMemory',
)(
  { _tag: Schema.tag('DuplicateMemory'), message: Schema.String },
  { httpApiStatus: 409 },
) {}
