import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { Effect } from 'effect';
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/http';

class TransferTimeout extends Error {}
export const transferTimeoutMessage =
  'The file transfer timed out after 10 seconds without progress. Try again.';
export function transferTimedOut(error: unknown) {
  return (
    error instanceof TransferTimeout ||
    (HttpClientError.isHttpClientError(error) &&
      error.reason.cause instanceof TransferTimeout)
  );
}

function webResponse(source: IncomingMessage, timedOut: () => boolean) {
  const headers = new Headers();
  for (let index = 0; index < source.rawHeaders.length; index += 2)
    headers.append(source.rawHeaders[index], source.rawHeaders[index + 1]);
  // Preserve backpressure and distinguish a socket's idle timeout from a
  // truncated response (Node otherwise reports both as an aborted stream).
  const body = Readable.from(
    (async function* () {
      try {
        yield* source;
      } catch (error) {
        throw timedOut() ? new TransferTimeout() : error;
      }
    })(),
    { objectMode: false },
  );
  return new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, {
    status: source.statusCode,
    headers,
  });
}

// File requests still come from HttpApi. Node's socket inactivity timer observes
// actual network reads/writes, including an upload blocked by backpressure;
// fetch exposes neither its socket nor upload progress. Other calls keep fetch.
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
              let timedOut = false;
              const send =
                url.protocol === 'https:' ? httpsRequest : httpRequest;
              const outgoing = send(url, {
                method: request.method,
                headers: request.headers,
                signal,
                agent: false,
                timeout: 10_000,
              });
              outgoing.once('timeout', () => {
                timedOut = true;
                outgoing.destroy(new TransferTimeout());
              });
              outgoing.once('error', reject);
              outgoing.once('response', (source) => {
                accept(
                  HttpClientResponse.fromWeb(
                    request,
                    webResponse(source, () => timedOut),
                  ),
                );
              });
              outgoing.end(body._tag === 'Uint8Array' ? body.body : undefined);
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
