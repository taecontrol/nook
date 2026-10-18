import type {
  D1Database,
  ExecutionContext,
  ScheduledController,
} from '@cloudflare/workers-types';
import { D1Client } from '@effect/sql-d1';
import {
  Api,
  type BucketGrant,
  badRequestTags,
  secretLimits,
} from '@nook/contract';
import { Effect, Layer } from 'effect';
import { HttpRouter, HttpServer, HttpServerRequest } from 'effect/http';
import { HttpApiBuilder } from 'effect/http-api';
import { auditStore } from './audit.ts';
import { type AuthBindings, authenticate } from './auth.ts';
import { bucketOperations } from './buckets.ts';
import {
  authorizationHandler,
  machineHandler,
  machineMcpHandler,
} from './machine-routes.ts';
import { machineOperations } from './machines.ts';
import { mcpHandler } from './mcp.ts';
import { memoryStore } from './memory.ts';
import { memoryIndex, type SearchBindings } from './memory-index.ts';
import { memorySync } from './memory-sync.ts';
import { matches, ownerRoutes, revealRoute, tokenRoutes } from './routes.ts';
import { ownerVault } from './vault.ts';

export function handlerForPrincipal(
  email: string,
  db: D1Database,
  grant: BucketGrant = 'all',
  vaultKey = '',
  searchBindings: SearchBindings = {},
) {
  const index = memoryIndex(searchBindings);
  const session = HttpApiBuilder.group(Api, 'session', (handlers) =>
    handlers.handle('whoami', () => Effect.succeed({ email })),
  );
  const memories = HttpApiBuilder.group(Api, 'memories', (handlers) =>
    Effect.gen(function* () {
      const store = yield* memoryStore(grant, index);
      return handlers
        .handle('forget', ({ params, query }) =>
          store
            .forget(
              { id: params.id, expectedVersion: query.expectedVersion },
              true,
            )
            .pipe(Effect.asVoid),
        )
        .handle('history', ({ params, query }) =>
          store.history(params.id, query.before),
        )
        .handle('search', ({ query }) =>
          store.search(query.bucket, query.q, [], query.scope),
        )
        .handle('counts', () => store.counts())
        .handle('list', ({ query }) =>
          store.list(query.bucket, query.cursor, query.scope),
        )
        .handle('get', ({ params }) => store.get(params.id));
    }),
  ).pipe(Layer.provide(D1Client.layer({ db })));
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
        .handle('saveGrant', ({ params, payload }) =>
          store.saveGrant(grant, params.id, payload.grant, payload.previous),
        )
        .handle('revoke', ({ params }) => store.revoke(grant, params.id));
    }),
  ).pipe(Layer.provide(D1Client.layer({ db })));
  const vault = HttpApiBuilder.group(Api, 'vault', (handlers) =>
    Effect.gen(function* () {
      const store = yield* ownerVault(vaultKey, grant);
      return handlers
        .handle('reveal', ({ params }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const source = request.source as Request & {
              cf?: { country?: string };
            };
            return yield* store.reveal(params.path, {
              ip: source.headers.get('CF-Connecting-IP') || null,
              country: source.cf?.country || null,
            });
          }),
        )
        .handle('list', () => store.listAll())
        .handle('create', ({ payload }) => store.create(payload))
        .handle('replace', ({ params, payload }) =>
          store.replace(params.path, payload),
        )
        .handle('remove', ({ params, query }) =>
          store.remove(params.path, query.version),
        );
    }),
  ).pipe(Layer.provide(D1Client.layer({ db })));
  const audit = HttpApiBuilder.group(Api, 'audit', (handlers) =>
    Effect.gen(function* () {
      const store = yield* auditStore;
      return handlers.handle('list', ({ query }) => store.list(grant, query));
    }),
  ).pipe(Layer.provide(D1Client.layer({ db })));
  const routes = HttpApiBuilder.layer(Api).pipe(
    Layer.provide([session, buckets, machines, vault, audit, memories]),
    Layer.provide(HttpServer.layerServices),
  );
  const apiHandler = HttpRouter.toWebHandler(routes, {
    disableLogger: true,
    // The router checks decoded params: six 32-character segments plus the name.
    routerConfig: { maxParamLength: 6 * (32 + 1) + secretLimits.name },
  }).handler;
  return (request: Request, ctx?: Pick<ExecutionContext, 'waitUntil'>) =>
    new URL(request.url).pathname === '/mcp'
      ? mcpHandler(
          db,
          { grant, principal: { kind: 'owner' } },
          { index, waitUntil: ctx?.waitUntil.bind(ctx) },
        ).fetch(request)
      : apiHandler(request);
}
let cached:
  | {
      email: string;
      db: D1Database;
      grant: BucketGrant;
      vaultKey: string;
      searchBindings: SearchBindings;
      handler: ReturnType<typeof handlerForPrincipal>;
    }
  | undefined;
function handlerFor(
  email: string,
  db: D1Database,
  grant: BucketGrant,
  vaultKey = '',
  searchBindings: SearchBindings = {},
) {
  if (
    cached?.email !== email ||
    cached.db !== db ||
    cached.grant !== grant ||
    cached.vaultKey !== vaultKey ||
    cached.searchBindings.AI !== searchBindings.AI ||
    cached.searchBindings.MEMORY_INDEX !== searchBindings.MEMORY_INDEX ||
    cached.searchBindings.EMBEDDING_MODEL !== searchBindings.EMBEDDING_MODEL
  )
    cached = {
      email,
      db,
      grant,
      vaultKey,
      searchBindings,
      handler: handlerForPrincipal(email, db, grant, vaultKey, searchBindings),
    };
  return cached.handler;
}
function foreignOrigin(request: Request, url: URL) {
  const origin = request.headers.get('Origin');
  return (
    (['/mcp', '/api/machine/mcp'].includes(url.pathname) ||
      !['GET', 'HEAD'].includes(request.method)) &&
    origin !== null &&
    origin !== url.origin
  );
}
function knownRoute(path: string, method: string) {
  return path === '/mcp' || matches(ownerRoutes, method, path);
}
let machineRoutes:
  | {
      db: D1Database;
      origin: string;
      vaultKey: string;
      machine: ReturnType<typeof machineHandler>;
      owner: ReturnType<typeof authorizationHandler>;
    }
  | undefined;
function routesFor(db: D1Database, origin: string, vaultKey = '') {
  if (
    machineRoutes?.db !== db ||
    machineRoutes.origin !== origin ||
    machineRoutes.vaultKey !== vaultKey
  )
    machineRoutes = {
      db,
      origin,
      vaultKey,
      machine: machineHandler(db, origin, vaultKey),
      owner: authorizationHandler(db),
    };
  return machineRoutes;
}
function invalidCreation(message = 'Invalid secret creation request.') {
  return Response.json({ _tag: 'InvalidSecret', message }, { status: 400 });
}
async function sanitized(response: Promise<Response>, creation = false) {
  const result = await response;
  if (result.status === 400) {
    const body = (await result
      .clone()
      .json()
      .catch(() => undefined)) as { _tag?: string } | undefined;
    if (!badRequestTags.has(body?._tag ?? ''))
      return creation
        ? invalidCreation()
        : Response.json({ _tag: 'BadRequest' }, { status: 400 });
  }
  return result;
}
async function checkedCreation(request: Request) {
  try {
    const body = await request.arrayBuffer();
    new TextDecoder('utf-8', { fatal: true }).decode(body);
    return new Request(request, { body });
  } catch {
    return invalidCreation('Use valid Unicode for the value.');
  }
}
async function machineApiResponse(
  request: Request,
  url: URL,
  db: D1Database,
  vaultKey: string,
) {
  const creation =
    url.pathname === '/api/machine/secrets' && request.method === 'POST';
  const checked = creation ? await checkedCreation(request) : request;
  if (checked instanceof Response) return checked;
  return sanitized(
    routesFor(db, url.origin, vaultKey).machine(checked),
    creation,
  );
}
async function machineRequest(
  request: Request,
  url: URL,
  db: D1Database,
  vaultKey = '',
  searchBindings: SearchBindings = {},
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
) {
  if (url.pathname === '/api/machine/mcp') {
    if (foreignOrigin(request, url))
      return Response.json({ _tag: 'Forbidden' }, { status: 403 });
    return machineMcpHandler(db, request, {
      index: memoryIndex(searchBindings),
      waitUntil: ctx?.waitUntil.bind(ctx),
    });
  }
  if (
    matches(tokenRoutes, request.method, url.pathname) &&
    !request.headers.has('Authorization')
  )
    return Response.json({ _tag: 'Unauthorized' }, { status: 401 });
  if (foreignOrigin(request, url))
    return Response.json({ _tag: 'Forbidden' }, { status: 403 });
  const response = await machineApiResponse(request, url, db, vaultKey);
  if (url.pathname === '/api/machine/secrets/values')
    response.headers.set('Cache-Control', 'no-store');
  return response;
}
export default {
  async fetch(
    request: Request,
    env: AuthBindings & SearchBindings & { DB: D1Database; VAULT_KEY?: string },
    ctx?: Pick<ExecutionContext, 'waitUntil'>,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/machine/'))
      return machineRequest(request, url, env.DB, env.VAULT_KEY, env, ctx);
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
    const response = await sanitized(
      handlerFor(
        identity.email,
        env.DB,
        identity.grant,
        env.VAULT_KEY,
        env,
      )(request, ctx),
    );
    if (matches([revealRoute], request.method, url.pathname))
      response.headers.set('Cache-Control', 'no-store');
    return response;
  },
  scheduled(
    controller: ScheduledController,
    env: SearchBindings & { DB: D1Database },
  ) {
    return Effect.runPromise(
      memorySync(memoryIndex(env)).pipe(
        Effect.flatMap((store) => store.sync(controller.scheduledTime)),
        Effect.provide(D1Client.layer({ db: env.DB })),
        // Failed writes leave their markers pending for the next scheduled run.
        Effect.catchCause(() => Effect.void),
      ),
    );
  },
};
