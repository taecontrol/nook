import { Schema } from 'effect';
import { HttpApiSchema } from 'effect/http-api';
import { MemoryClient, Principal } from './provenance.ts';

export const fileLimits = {
  bytes: 25 * 1024 * 1024,
  bucketBytes: 1024 * 1024 * 1024,
  nameBytes: 255,
} as const;

// Leave room for percent-encoded file names up to fileLimits.nameBytes.
export const fileRouterMaxParamLength = 800;
export const fileNameUnicodeMessage = 'Use valid Unicode for the file name.';

export function validateFileSize(size: number): string | undefined {
  if (size > fileLimits.bytes) return 'A file can be at most 25 MiB.';
}
export function isFileDigest(sha256: string): boolean {
  return /^[0-9a-f]{64}$/.test(sha256);
}
export function validateFileName(name: string): string | undefined {
  if (!name || name === '.' || name === '..') return 'Use a file name.';
  if (/[\\/\p{Cc}]/u.test(name))
    return 'A file name cannot contain slashes or control characters.';
  if (/[\uD800-\uDFFF]/u.test(name)) return fileNameUnicodeMessage;
  if (new TextEncoder().encode(name).length > fileLimits.nameBytes)
    return 'A file name can be at most 255 UTF-8 bytes.';
}
export function validateMediaType(mediaType: string): string | undefined {
  if (
    mediaType.length > 255 ||
    !/^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(mediaType)
  )
    return 'Use a media type such as application/pdf.';
}
export const FileParams = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});
export const FileBytes = Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array());
export const FileStream = HttpApiSchema.StreamUint8Array({
  contentType: 'application/octet-stream',
});
export const MemoryFile = Schema.Struct({
  name: Schema.String,
  mediaType: Schema.String,
  size: Schema.Number,
  sha256: Schema.String,
});
export type MemoryFile = typeof MemoryFile.Type;
export const OwnerMemoryFile = MemoryFile.mapFields((fields) => ({
  ...fields,
  attachedAt: Schema.String,
  principal: Principal,
  client: MemoryClient,
}));
export type OwnerMemoryFile = typeof OwnerMemoryFile.Type;
export const FileAttached = MemoryFile.mapFields((fields) => ({
  ...fields,
  id: Schema.String,
  bucket: Schema.String,
  outcome: Schema.Literals(['created', 'unchanged', 'replaced']),
  replacedSha256: Schema.NullOr(Schema.String),
}));
export type FileAttached = typeof FileAttached.Type;
export const DetachFile = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  sha256: Schema.String,
});
export type DetachFile = typeof DetachFile.Type;
export const Detached = Schema.Struct({
  id: Schema.String,
  bucket: Schema.String,
  name: Schema.String,
  sha256: Schema.String,
});
export type Detached = typeof Detached.Type;
export class InvalidFile extends Schema.Error<InvalidFile>('nook/InvalidFile')(
  { _tag: Schema.tag('InvalidFile'), message: Schema.String },
  { httpApiStatus: 400 },
) {}
export class FileNotFound extends Schema.Error<FileNotFound>(
  'nook/FileNotFound',
)(
  { _tag: Schema.tag('FileNotFound'), message: Schema.String },
  { httpApiStatus: 404 },
) {}
export class FileChanged extends Schema.Error<FileChanged>('nook/FileChanged')(
  { _tag: Schema.tag('FileChanged'), message: Schema.String },
  { httpApiStatus: 409 },
) {}
export class FileTooLarge extends Schema.Error<FileTooLarge>(
  'nook/FileTooLarge',
)(
  { _tag: Schema.tag('FileTooLarge'), message: Schema.String },
  { httpApiStatus: 413 },
) {}
export class FileQuotaExceeded extends Schema.Error<FileQuotaExceeded>(
  'nook/FileQuotaExceeded',
)(
  { _tag: Schema.tag('FileQuotaExceeded'), message: Schema.String },
  { httpApiStatus: 409 },
) {}
