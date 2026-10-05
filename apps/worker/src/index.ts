import type { D1Database } from '@cloudflare/workers-types';
import { D1Client } from '@effect/sql-d1';
import { Api } from '@nook/contract';
import { Effect, Layer } from 'effect';
import { HttpRouter, HttpServer } from 'effect/http';
import { HttpApiBuilder } from 'effect/http-api';
import { type AuthBindings, authenticate } from './auth.ts';
import type { BucketGrant } from './authorization.ts';
import { bucketOperations } from './buckets.ts';
import { authorizationHandler, machineHandler } from './machine-routes.ts';
import { machineOperations } from './machines.ts';
import { mcpHandler } from './mcp.ts';

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
  const machines = HttpApiBuilder.group(Api, 'machines', (handlers) =>
    Effect.gen(function* () {
      const store = yield* machineOperations;
      return handlers
        .handle('list', () => store.list(grant))
        .handle('revoke', ({ params }) => store.revoke(grant, params.id));
    }),
  ).pipe(Layer.provide(D1Client.layer({ db })));
  const routes = HttpApiBuilder.layer(Api).pipe(
    Layer.provide([session, buckets, machines]),
    Layer.provide(HttpServer.layerServices),
  );
  const apiHandler = HttpRouter.toWebHandler(routes, {
    disableLogger: true,
  }).handler;
  return (request: Request) =>
    new URL(request.url).pathname === '/mcp'
      ? mcpHandler(db, grant).fetch(request)
      : apiHandler(request);
}
let cached:
  | {
      email: string;
      db: D1Database;
      grant: BucketGrant;
      handler: ReturnType<typeof handlerForPrincipal>;
    }
  | undefined;
function handlerFor(email: string, db: D1Database, grant: BucketGrant) {
  if (cached?.email !== email || cached.db !== db || cached.grant !== grant)
    cached = {
      email,
      db,
      grant,
      handler: handlerForPrincipal(email, db, grant),
    };
  return cached.handler;
}
function foreignOrigin(request: Request, url: URL) {
  const origin = request.headers.get('Origin');
  return (
    (url.pathname === '/mcp' || ['POST', 'DELETE'].includes(request.method)) &&
    origin !== null &&
    origin !== url.origin
  );
}
function knownRoute(path: string, method: string) {
  return (
    ['/api/whoami', '/api/buckets', '/api/machines', '/mcp'].includes(path) ||
    ((path.startsWith('/api/buckets/') || path.startsWith('/api/machines/')) &&
      method === 'DELETE')
  );
}
let machineRoutes:
  | {
      db: D1Database;
      origin: string;
      machine: ReturnType<typeof machineHandler>;
      owner: ReturnType<typeof authorizationHandler>;
    }
  | undefined;
function routesFor(db: D1Database, origin: string) {
  if (machineRoutes?.db !== db || machineRoutes.origin !== origin)
    machineRoutes = {
      db,
      origin,
      machine: machineHandler(db, origin),
      owner: authorizationHandler(db),
    };
  return machineRoutes;
}
async function sanitized(response: Promise<Response>) {
  const result = await response;
  if (result.status === 400) {
    const body = (await result
      .clone()
      .json()
      .catch(() => undefined)) as { _tag?: string } | undefined;
    if (
      ![
        'pending',
        'denied',
        'expired',
        'invalid',
        'InvalidMachineName',
      ].includes(body?._tag ?? '')
    )
      return Response.json({ _tag: 'BadRequest' }, { status: 400 });
  }
  return result;
}
function machineRequest(request: Request, url: URL, db: D1Database) {
  const protectedRoute =
    url.pathname === '/api/machine/whoami' ||
    (url.pathname === '/api/machine/token' && request.method === 'DELETE');
  if (protectedRoute && !request.headers.has('Authorization'))
    return Response.json({ _tag: 'Unauthorized' }, { status: 401 });
  if (foreignOrigin(request, url))
    return Response.json({ _tag: 'Forbidden' }, { status: 403 });
  return sanitized(routesFor(db, url.origin).machine(request));
}
export default {
  async fetch(
    request: Request,
    env: AuthBindings & { DB: D1Database },
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/machine/'))
      return machineRequest(request, url, env.DB);
    const identity = await authenticate(request, env);
    if ('status' in identity)
      return Response.json(
        { _tag: identity.status === 401 ? 'Unauthorized' : 'Forbidden' },
        { status: identity.status },
      );
    if (foreignOrigin(request, url))
      return Response.json({ _tag: 'Forbidden' }, { status: 403 });
    if (url.pathname.startsWith('/api/authorizations/'))
      return sanitized(routesFor(env.DB, url.origin).owner(request));
    if (!knownRoute(url.pathname, request.method))
      return Response.json({ error: 'Not found' }, { status: 404 });
    return handlerFor(identity.email, env.DB, identity.grant)(request);
  },
};
