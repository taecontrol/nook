import type { Effect } from 'effect';
import { HttpServerResponse } from 'effect/http';
import type { memoryFiles } from './memory-files.ts';

type Store = Effect.Success<ReturnType<typeof memoryFiles>>;
type Download = Effect.Success<ReturnType<Store['download']>>;
export function fileResponse({ file, body }: Download) {
  const { FixedLengthStream } = globalThis as unknown as {
    FixedLengthStream: new (
      size: number,
    ) => TransformStream<Uint8Array, Uint8Array>;
  };
  const fixed = new FixedLengthStream(file.size);
  // A source error or truncation aborts the fixed-length readable. Consume only
  // the pipe rejection; the response stream still reports the failed transfer.
  void body.pipeTo(fixed.writable).catch(() => undefined);
  const name = encodeURIComponent(file.name).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  // Preserve workerd's native fixed-length body through Effect's adapter.
  // Re-wrapping it as an Effect Stream loses its known length at the edge.
  return HttpServerResponse.raw(fixed.readable, {
    contentType: 'application/octet-stream',
    contentLength: file.size,
    headers: {
      'content-disposition': `attachment; filename*=UTF-8''${name}`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
      'cache-control': 'no-store',
      'x-nook-sha256': file.sha256,
    },
  });
}
