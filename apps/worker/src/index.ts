import { Api } from '@nook/contract';
import { Effect, Layer } from 'effect';
import { HttpRouter, HttpServer } from 'effect/http';
import { HttpApiBuilder } from 'effect/http-api';
import { type AuthBindings, authenticate } from './auth.ts';

let ownerApi:
  | { email: string; handler: (request: Request) => Promise<Response> }
  | undefined;

function handlerFor(email: string) {
  if (ownerApi?.email !== email) {
    const session = HttpApiBuilder.group(Api, 'session', (handlers) =>
      handlers.handle('whoami', () => Effect.succeed({ email })),
    );
    const routes = HttpApiBuilder.layer(Api).pipe(
      Layer.provide(session),
      Layer.provide(HttpServer.layerServices),
    );
    ownerApi = {
      email,
      handler: HttpRouter.toWebHandler(routes, { disableLogger: true }).handler,
    };
  }
  return ownerApi.handler;
}

export default {
  async fetch(request: Request, env: AuthBindings): Promise<Response> {
    const identity = await authenticate(request, env);
    if ('status' in identity) {
      return Response.json(
        { _tag: identity.status === 401 ? 'Unauthorized' : 'Forbidden' },
        { status: identity.status },
      );
    }
    const path = new URL(request.url).pathname;
    if (path !== '/api/whoami')
      return Response.json({ error: 'Not found' }, { status: 404 });
    return handlerFor(identity.email)(request);
  },
};
