import { type MemoryScope, RESERVED_BUCKET } from '@nook/contract';

export type MemorySearch = {
  bucket?: string;
  memory?: string;
  scope?: MemoryScope;
  q?: string;
  history?: '1';
  version?: number;
  changes?: '1';
};
function historySearch(search: Record<string, unknown>) {
  return {
    ...(search.history === '1' || search.history === 1
      ? { history: '1' as const }
      : {}),
    ...(Number.isSafeInteger(Number(search.version)) &&
    Number(search.version) > 0
      ? { version: Number(search.version) }
      : {}),
    ...(search.changes === '1' || search.changes === 1
      ? { changes: '1' as const }
      : {}),
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
    ...historySearch(input),
  };
  return {
    search,
    bucket: search.bucket ?? RESERVED_BUCKET,
    scope: search.scope ?? 'inherited',
    q,
  };
}
