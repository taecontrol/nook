import { Schema } from 'effect';
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
} from 'effect/http-api';

export const Owner = Schema.Struct({ email: Schema.String });
export type Owner = typeof Owner.Type;

export const Api = HttpApi.make('nook').add(
  HttpApiGroup.make('session').add(
    HttpApiEndpoint.get('whoami', '/api/whoami', {
      success: Owner,
      error: [HttpApiError.Unauthorized, HttpApiError.Forbidden],
    }),
  ),
);
