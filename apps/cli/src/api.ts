import { MachineApi } from '@nook/contract';
import { Effect, Schema } from 'effect';
import { FetchHttpClient, HttpClientError } from 'effect/http';
import { HttpApiClient } from 'effect/http-api';
import { ServerFailure } from './errors.ts';

export function machineApi(url: string) {
  const client = HttpApiClient.make(MachineApi, { baseUrl: url });
  return function request<A, E>(
    operation: (api: Effect.Success<typeof client>) => Effect.Effect<A, E>,
  ) {
    return Effect.flatMap(client, operation).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.timeout('10 seconds'),
      Effect.catch((error) =>
        serverFailure(error).pipe(Effect.flatMap(Effect.fail)),
      ),
    );
  };
}

const PublicError = Schema.Struct({
  _tag: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
});
function responseFailure(error: HttpClientError.HttpClientError) {
  const response = error.response;
  if (!response)
    return Effect.succeed(
      new ServerFailure('Unavailable', undefined, [], true),
    );
  return response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PublicError)),
    Effect.map(
      (body) =>
        new ServerFailure(
          body._tag ?? 'Unavailable',
          body.message,
          [],
          response.status >= 500 && body._tag !== 'VaultNotConfigured',
        ),
    ),
    Effect.catch(() =>
      Effect.succeed(
        new ServerFailure('Unavailable', undefined, [], response.status >= 500),
      ),
    ),
  );
}
function serverFailure(error: unknown) {
  if (HttpClientError.isHttpClientError(error)) return responseFailure(error);
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
