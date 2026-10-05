import { MachineApi } from '@nook/contract';
import { Effect } from 'effect';
import { FetchHttpClient } from 'effect/http';
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
      Effect.mapError(
        (error) =>
          new ServerFailure((error as { _tag?: string })._tag ?? 'Unavailable'),
      ),
    );
  };
}
