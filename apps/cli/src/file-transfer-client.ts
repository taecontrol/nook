import {
  type ClientRequest,
  request as httpRequest,
  type IncomingMessage,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { Effect } from 'effect';
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/http';

class TransferTimeout extends Error {}
const transferInactivityMs = 10_000;
// Small enough that a link sending 1.6 KB/s still completes one chunk per window.
const uploadChunkBytes = 16 * 1024;
export const transferTimeoutMessage = `The file transfer timed out after ${transferInactivityMs / 1000} seconds without progress. Try again.`;
export function transferTimedOut(error: unknown) {
  return (
    error instanceof TransferTimeout ||
    (HttpClientError.isHttpClientError(error) &&
      error.reason.cause instanceof TransferTimeout)
  );
}

type Inactivity = { progress: () => void; timedOut: () => boolean };

function webResponse(source: IncomingMessage, inactivity: Inactivity) {
  const headers = new Headers();
  for (let index = 0; index < source.rawHeaders.length; index += 2)
    headers.append(source.rawHeaders[index], source.rawHeaders[index + 1]);
  // Preserve backpressure and distinguish a socket's idle timeout from a
  // truncated response (Node otherwise reports both as an aborted stream).
  const body = Readable.from(
    (async function* () {
      try {
        for await (const chunk of source) {
          inactivity.progress();
          yield chunk;
        }
      } catch (error) {
        throw inactivity.timedOut() ? new TransferTimeout() : error;
      }
    })(),
    { objectMode: false },
  );
  return new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, {
    status: source.statusCode,
    headers,
  });
}

// Each completed write means the socket accepted that chunk, so a stalled
// upload stops completing writes. A single write of the whole body would hide
// that progress until the body was fully sent.
async function upload(
  outgoing: ClientRequest,
  bytes: Uint8Array,
  progress: () => void,
) {
  for (let offset = 0; offset < bytes.byteLength; offset += uploadChunkBytes) {
    await new Promise<void>((accept, reject) =>
      outgoing.write(
        bytes.subarray(offset, offset + uploadChunkBytes),
        (error) => (error ? reject(error) : accept()),
      ),
    );
    progress();
  }
  outgoing.end();
}

// File requests still come from HttpApi because fetch exposes neither its
// socket nor upload progress. Other calls keep fetch. The client times
// inactivity itself: Node's socket timeout samples a blocked write only when
// it expires, so it reports a stalled upload one or more windows late.
export const fileTransferLayer = HttpClient.layerMergedContext(
  Effect.succeed(
    HttpClient.make((request, url, signal) =>
      Effect.tryPromise({
        try: () =>
          new Promise<HttpClientResponse.HttpClientResponse>(
            (accept, reject) => {
              const body = request.body;
              if (body._tag !== 'Empty' && body._tag !== 'Uint8Array')
                throw new Error('Unsupported file request body.');
              const send =
                url.protocol === 'https:' ? httpsRequest : httpRequest;
              const bytes = body._tag === 'Uint8Array' ? body.body : undefined;
              const outgoing = send(url, {
                method: request.method,
                // Written in chunks, a body would otherwise be sent chunked.
                headers: bytes
                  ? {
                      ...request.headers,
                      'content-length': String(bytes.byteLength),
                    }
                  : request.headers,
                signal,
                agent: false,
              });
              let timedOut = false;
              const timer = setTimeout(() => {
                timedOut = true;
                outgoing.destroy(new TransferTimeout());
              }, transferInactivityMs).unref();
              const inactivity: Inactivity = {
                progress: () => timer.refresh(),
                timedOut: () => timedOut,
              };
              outgoing.once('close', () => clearTimeout(timer));
              outgoing.once('error', reject);
              outgoing.once('response', (source) => {
                inactivity.progress();
                accept(
                  HttpClientResponse.fromWeb(
                    request,
                    webResponse(source, inactivity),
                  ),
                );
              });
              if (!bytes) outgoing.end();
              // A failed write also emits 'error' on the request.
              else upload(outgoing, bytes, inactivity.progress).catch(() => {});
            },
          ),
        catch: (cause) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause }),
          }),
      }),
    ),
  ),
);
