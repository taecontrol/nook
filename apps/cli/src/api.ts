import { MachineApi } from '@nook/contract';
import { Effect, Schema } from 'effect';
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
} from 'effect/http';
import { HttpApiClient } from 'effect/http-api';
import cliPackage from '../package.json' with { type: 'json' };
import { ServerFailure } from './errors.ts';
import { fileTransferLayer, transferTimedOut } from './file-transfer-client.ts';

export type MachineClient = HttpApiClient.ForApi<typeof MachineApi>;

export type RequestOptions = { transfer?: boolean };
export function machineApi(
  url: string,
  { transfer = false }: RequestOptions = {},
) {
  const client = HttpApiClient.make(MachineApi, {
    baseUrl: url,
    transformClient: (http) =>
      http.pipe(
        HttpClient.mapRequest(
          HttpClientRequest.setHeader(
            'user-agent',
            `nook/${cliPackage.version}`,
          ),
        ),
        // Keep route-level 404s distinguishable from declared domain errors,
        // even when an older Worker returns a body outside the current schema.
        HttpClient.filterStatus((status) => status !== 404),
      ),
  });
  return function request<A, E>(
    operation: (api: Effect.Success<typeof client>) => Effect.Effect<A, E>,
  ) {
    const result = Effect.flatMap(client, operation).pipe(
      Effect.provide(transfer ? fileTransferLayer : FetchHttpClient.layer),
      Effect.catch((error) =>
        serverFailure(error).pipe(Effect.flatMap(Effect.fail)),
      ),
    );
    return (transfer ? result : result.pipe(Effect.timeout('10 seconds'))).pipe(
      Effect.mapError((error) =>
        error instanceof ServerFailure
          ? error
          : new ServerFailure('TimeoutError', undefined, [], true),
      ),
    );
  };
}

const PublicError = Schema.Struct({
  _tag: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
});
function publicFailure(text: string, status: number) {
  const fallback = status === 404 ? 'NotFound' : 'Unavailable';
  try {
    const body = Schema.decodeUnknownSync(PublicError)(JSON.parse(text));
    return new ServerFailure(
      body._tag ?? fallback,
      body.message,
      [],
      status >= 500 && body._tag !== 'VaultNotConfigured',
    );
  } catch {
    return new ServerFailure(fallback, undefined, [], status >= 500);
  }
}
function responseFailure(error: HttpClientError.HttpClientError) {
  const response = error.response;
  if (!response)
    return Effect.succeed(
      new ServerFailure('Unavailable', undefined, [], true),
    );
  return response.text.pipe(
    Effect.match({
      onSuccess: (text) => publicFailure(text, response.status),
      onFailure: () => new ServerFailure('Unavailable', undefined, [], true),
    }),
  );
}
function serverFailure(error: unknown) {
  if (transferTimedOut(error))
    return Effect.succeed(
      new ServerFailure('TimeoutError', undefined, [], true),
    );
  if (HttpClientError.isHttpClientError(error)) return responseFailure(error);
  if (Schema.isSchemaError(error))
    return Effect.succeed(
      new ServerFailure('Unavailable', undefined, [], true),
    );
  const typed = error as {
    _tag?: string;
    message?: string;
    paths?: readonly string[];
  };
  const tag = typed._tag ?? 'Unavailable';
  const transient = [
    'ServiceUnavailable',
    'TimeoutError',
    'Unavailable',
  ].includes(tag);
  return Effect.succeed(
    new ServerFailure(
      tag,
      transient ? undefined : typed.message,
      tag === 'SecretsForbidden' ? typed.paths : [],
      transient,
    ),
  );
}
