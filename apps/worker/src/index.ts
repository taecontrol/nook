import type { D1Database } from '@cloudflare/workers-types';
import { D1Client } from '@effect/sql-d1';
import { Api } from '@nook/contract';
import { Effect, Layer } from 'effect';
import { HttpRouter, HttpServer } from 'effect/http';
import { HttpApiBuilder } from 'effect/http-api';
import { type AuthBindings, authenticate } from './auth.ts';
import type { BucketGrant } from './authorization.ts';
import { bucketOperations } from './buckets.ts';

export function handlerForPrincipal(
  email: string,
  db: D1Database,
  grant: BucketGrant = 'all',
) {
  const session = HttpApiBuilder.group(Api, 'session', (handlers) =>
    handlers.handle('whoami', () => Effect.succeed({ email })),
  );
  const buckets = HttpApiBuilder.group(Api, 'buckets', (handlers) =>
    Effect.gen(function* () {
      const store = yield* bucketOperations;
      return handlers
        .handle('list', () => store.list(grant))
        .handle('create', ({ payload }) => store.create(grant, payload.path))
        .handle('delete', ({ params }) => store.delete(grant, params.path));
    }),
  ).pipe(Layer.provide(D1Client.layer({ db })));
  const routes = HttpApiBuilder.layer(Api).pipe(
    Layer.provide([session, buckets]),
    Layer.provide(HttpServer.layerServices),
  );
  return HttpRouter.toWebHandler(routes, { disableLogger: true }).handler;
}
let cached:
  | {
      email: string;
      db: D1Database;
      handler: ReturnType<typeof handlerForPrincipal>;
    }
  | undefined;
function handlerFor(email: string, db: D1Database) {
  if (cached?.email !== email || cached.db !== db)
    cached = { email, db, handler: handlerForPrincipal(email, db) };
  return cached.handler;
}
function foreignWrite(request: Request, url: URL) {
  const origin = request.headers.get('Origin');
  return (
    ['POST', 'DELETE'].includes(request.method) &&
    origin !== null &&
    origin !== url.origin
  );
}
function knownRoute(path: string, method: string) {
  return (
    ['/api/whoami', '/api/buckets'].includes(path) ||
    (path.startsWith('/api/buckets/') && method === 'DELETE')
  );
}
export default {
  async fetch(
    request: Request,
    env: AuthBindings & { DB: D1Database },
  ): Promise<Response> {
    const identity = await authenticate(request, env);
    if ('status' in identity)
      return Response.json(
        { _tag: identity.status === 401 ? 'Unauthorized' : 'Forbidden' },
        { status: identity.status },
      );
    const url = new URL(request.url);
    if (foreignWrite(request, url))
      return Response.json({ _tag: 'Forbidden' }, { status: 403 });
    if (!knownRoute(url.pathname, request.method))
      return Response.json({ error: 'Not found' }, { status: 404 });
    return handlerFor(identity.email, env.DB)(request);
  },
};
