import { type MemoryScope, RESERVED_BUCKET } from '@nook/contract';

export type MemorySearch = {
  bucket?: string;
  memory?: string;
  scope?: MemoryScope;
  q?: string;
  history?: '1';
  version?: number;
  changes?: '1';
  files?: '1';
};
function enabledFlag(value: unknown) {
  return value === '1' || value === 1;
}
function readerSearch(search: Record<string, unknown>) {
  return {
    ...(enabledFlag(search.history) ? { history: '1' as const } : {}),
    ...(Number.isSafeInteger(Number(search.version)) &&
    Number(search.version) > 0
      ? { version: Number(search.version) }
      : {}),
    ...(enabledFlag(search.files) ? { files: '1' as const } : {}),
    ...(enabledFlag(search.changes) ? { changes: '1' as const } : {}),
  };
}
export function memoryQueryText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}
export function memoryLocation(input: Record<string, unknown>) {
  const q = memoryQueryText(input.q);
  const search: MemorySearch = {
    ...(typeof input.bucket === 'string' ? { bucket: input.bucket } : {}),
    ...(typeof input.memory === 'string' ? { memory: input.memory } : {}),
    ...(input.scope === 'bucket' || input.scope === 'inherited'
      ? { scope: input.scope }
      : {}),
    ...(q ? { q: String(input.q) } : {}),
    ...readerSearch(input),
  };
  return {
    search,
    bucket: search.bucket ?? RESERVED_BUCKET,
    scope: search.scope ?? 'inherited',
    q,
  };
}
