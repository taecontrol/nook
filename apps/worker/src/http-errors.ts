import { Effect } from 'effect';
import { HttpApiError } from 'effect/http-api';

export const unavailable = Effect.mapError(
  () => new HttpApiError.ServiceUnavailable(),
);
