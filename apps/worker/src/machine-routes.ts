import type { D1Database } from '@cloudflare/workers-types';
import { D1Client } from '@effect/sql-d1';
import { AuthorizationsApi, MachineApi } from '@nook/contract';
import { Effect, Layer } from 'effect';
import { HttpRouter, HttpServer } from 'effect/http';
import { HttpApiBuilder } from 'effect/http-api';
import { machineOperations } from './machines.ts';

export function machineHandler(db: D1Database, origin: string) {
  const handlers = HttpApiBuilder.group(MachineApi, 'machine', (handlers) =>
    Effect.gen(function* () {
      const store = yield* machineOperations;
      return handlers
        .handle('authorize', ({ payload }) =>
          store.create(origin, payload.suggestedName, payload.client),
        )
        .handle('poll', ({ payload }) => store.poll(payload.deviceCode))
        .handle('whoami', ({ headers }) => store.whoami(headers.authorization))
        .handle('logout', ({ headers }) => store.logout(headers.authorization));
    }),
  ).pipe(Layer.provide(D1Client.layer({ db })));
  const routes = HttpApiBuilder.layer(MachineApi).pipe(
    Layer.provide(handlers),
    Layer.provide(HttpServer.layerServices),
  );
  return HttpRouter.toWebHandler(routes, { disableLogger: true }).handler;
}
export function authorizationHandler(db: D1Database) {
  const handlers = HttpApiBuilder.group(
    AuthorizationsApi,
    'authorizations',
    (handlers) =>
      Effect.gen(function* () {
        const store = yield* machineOperations;
        return handlers
          .handle('lookup', ({ params }) => store.lookup(params.userCode))
          .handle('approve', ({ params, payload }) =>
            store.approve(params.userCode, payload.machineName),
          )
          .handle('deny', ({ params }) => store.deny(params.userCode));
      }),
  ).pipe(Layer.provide(D1Client.layer({ db })));
  const routes = HttpApiBuilder.layer(AuthorizationsApi).pipe(
    Layer.provide(handlers),
    Layer.provide(HttpServer.layerServices),
  );
  return HttpRouter.toWebHandler(routes, { disableLogger: true }).handler;
}
