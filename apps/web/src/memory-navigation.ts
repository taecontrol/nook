import type { MemorySearch } from './memory-location';

export function memorySearch(
  location: Pick<MemorySearch, 'bucket' | 'scope' | 'q'>,
  selection: MemorySearch = {},
): MemorySearch {
  return {
    bucket: location.bucket,
    scope: location.scope,
    q: location.q || undefined,
    ...selection,
  };
}
