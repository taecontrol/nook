import type { D1Database } from '@cloudflare/workers-types';
import type { AuthBindings } from './auth.ts';
import type { FileBindings } from './file-objects.ts';
import type { SearchBindings } from './memory-index.ts';

export type MemoryBindings = SearchBindings & FileBindings;
export type WorkerBindings = AuthBindings &
  MemoryBindings & { DB: D1Database; VAULT_KEY?: string };

const fileKeys = ['FILES', 'FILE_CLOCK'] as const;
const cacheKeys = {
  files: fileKeys,
  all: ['AI', 'MEMORY_INDEX', 'EMBEDDING_MODEL', ...fileKeys],
} as const;

export function sameBindings(
  left: MemoryBindings,
  right: MemoryBindings,
  scope: keyof typeof cacheKeys = 'all',
) {
  return cacheKeys[scope].every((key) => left[key] === right[key]);
}
