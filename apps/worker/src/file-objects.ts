import type { R2Bucket } from '@cloudflare/workers-types';
import { Effect } from 'effect';
import { HttpApiError } from 'effect/http-api';

export type FileBindings = {
  FILES?: R2Bucket;
  FILE_CLOCK?: { now(): number };
};
export const fileNow = (bindings: FileBindings) =>
  bindings.FILE_CLOCK?.now() ?? Date.now();

// The binding can be decorated by the test runtime; no storage error escapes.
export function fileObjects(bindings: FileBindings) {
  function call<A>(operation: (bucket: R2Bucket) => Promise<A>) {
    return Effect.tryPromise({
      try: () => {
        if (!bindings.FILES) throw new Error('File storage unavailable');
        return operation(bindings.FILES);
      },
      catch: () => new HttpApiError.ServiceUnavailable(),
    });
  }
  return {
    put: (key: string, bytes: Uint8Array, sha256: string) =>
      call((bucket) => bucket.put(key, bytes, { sha256 })),
    get: (key: string) =>
      call(async (bucket) => {
        const object = await bucket.get(key);
        return object
          ? (object.body as unknown as ReadableStream<Uint8Array>)
          : null;
      }),
    remove: (keys: readonly string[]) =>
      Effect.gen(function* () {
        for (let offset = 0; offset < keys.length; offset += 1000)
          yield* call((bucket) =>
            bucket.delete(keys.slice(offset, offset + 1000)),
          );
      }),
    list: (cursor?: string) =>
      call(async (bucket) => {
        const page = await bucket.list({
          prefix: 'files/',
          cursor,
          limit: 1000,
        });
        return {
          objects: page.objects.map(({ key, uploaded }) => ({
            key,
            uploaded,
          })),
          cursor: page.truncated ? page.cursor : null,
        };
      }),
  };
}
