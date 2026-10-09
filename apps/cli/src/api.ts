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
      Effect.catch((error) =>
        serverFailure(error).pipe(Effect.flatMap(Effect.fail)),
      ),
      Effect.timeout('10 seconds'),
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
  try {
    const body = Schema.decodeUnknownSync(PublicError)(JSON.parse(text));
    return new ServerFailure(
      body._tag ?? 'Unavailable',
      body.message,
      [],
      status >= 500 && body._tag !== 'VaultNotConfigured',
    );
  } catch {
    return new ServerFailure('Unavailable', undefined, [], status >= 500);
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
