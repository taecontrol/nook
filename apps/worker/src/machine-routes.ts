import type { D1Database } from '@cloudflare/workers-types';
import { D1Client } from '@effect/sql-d1';
import {
  AuthorizationsApi,
  fileRouterMaxParamLength,
  MachineApi,
} from '@nook/contract';
import { Effect, Layer } from 'effect';
import { HttpRouter, HttpServer } from 'effect/http';
import { HttpApiBuilder } from 'effect/http-api';
import { machineFileActor } from './audit.ts';
import { clientFrom } from './client-provenance.ts';
import type { FileBindings } from './file-objects.ts';
import { fileResponse } from './file-response.ts';
import { unavailable as storageUnavailable } from './http-errors.ts';
import { machineOperations } from './machines.ts';
import { mcpHandler } from './mcp.ts';
import { memoryFiles } from './memory-files.ts';
import { runSecrets } from './run-secrets.ts';
import { machineVault } from './vault.ts';

export function machineMcpHandler(
  db: D1Database,
  request: Request,
  options: Parameters<typeof mcpHandler>[2] = {},
) {
  const unavailable = () =>
    Response.json({ _tag: 'ServiceUnavailable' }, { status: 503 });
  return Effect.runPromise(
    machineOperations.pipe(
      Effect.flatMap((store) =>
        store.forAudit(request.headers.get('Authorization') ?? ''),
      ),
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.succeed(
            error._tag === 'Unauthorized'
              ? Response.json({ _tag: 'Unauthorized' }, { status: 401 })
              : unavailable(),
          ),
        onSuccess: ({ grant, id, machine }) =>
          Effect.promise(() =>
            mcpHandler(
              db,
              {
                grant,
                principal: { kind: 'machine', id, name: machine },
              },
              options,
            ).fetch(request),
          ),
      }),
      Effect.provide(D1Client.layer({ db })),
      Effect.catchCause(() => Effect.succeed(unavailable())),
    ),
  );
}

export function machineHandler(
  db: D1Database,
  origin: string,
  vaultKey = '',
  files: FileBindings = {},
) {
  const handlers = HttpApiBuilder.group(MachineApi, 'machine', (handlers) =>
    Effect.gen(function* () {
      const store = yield* machineOperations;
      const sql = yield* D1Client.D1Client;
      const fileAccess = (authorization: string, userAgent: string | null) =>
        Effect.gen(function* () {
          const machine = yield* store.forAudit(authorization);
          const attachments = yield* memoryFiles(machine.grant, files);
          const actor = machineFileActor(
            { id: machine.id, name: machine.machine },
            clientFrom(undefined, userAgent),
          );
          return { attachments, actor };
        }).pipe(Effect.provideService(D1Client.D1Client, sql));
      return handlers
        .handleRaw('attachFile', ({ params, headers, request }) =>
          Effect.gen(function* () {
            const { attachments, actor } = yield* fileAccess(
              headers.authorization,
              request.headers['user-agent'] ?? null,
            );
            const bytes = new Uint8Array(
              yield* request.arrayBuffer.pipe(storageUnavailable),
            );
            return yield* attachments.attach(actor, {
              ...params,
              bytes,
              mediaType: headers['content-type'],
            });
          }),
        )
        .handleRaw('downloadFile', ({ params, headers, request }) =>
          Effect.gen(function* () {
            const { attachments, actor } = yield* fileAccess(
              headers.authorization,
              request.headers['user-agent'] ?? null,
            );
            return fileResponse(
              yield* attachments.download(actor, params.id, params.name),
            );
          }),
        )
        .handle('authorize', ({ payload }) =>
          store.create(origin, payload.suggestedName, payload.client),
        )
        .handle('poll', ({ payload }) => store.poll(payload.deviceCode))
        .handle('whoami', ({ headers }) => store.whoami(headers.authorization))
        .handle('secrets', ({ headers, query }) =>
          Effect.gen(function* () {
            const { grant } = yield* store.whoami(headers.authorization);
            const vault = yield* machineVault(grant);
            return yield* vault.list(query.bucket);
          }).pipe(Effect.provideService(D1Client.D1Client, sql)),
        )
        .handle('values', ({ headers, payload }) =>
          store.forAudit(headers.authorization).pipe(
            Effect.flatMap((machine) => runSecrets(machine, payload, vaultKey)),
            Effect.provideService(D1Client.D1Client, sql),
          ),
        )
        .handle('createSecret', ({ headers, payload }) =>
          Effect.gen(function* () {
            const machine = yield* store.forAudit(headers.authorization);
            const vault = yield* machineVault(machine.grant, vaultKey);
            return yield* vault.create(machine, payload);
          }).pipe(Effect.provideService(D1Client.D1Client, sql)),
        )
        .handle('logout', ({ headers }) => store.logout(headers.authorization));
    }),
  ).pipe(Layer.provide(D1Client.layer({ db })));
  const routes = HttpApiBuilder.layer(MachineApi).pipe(
    Layer.provide(handlers),
    Layer.provide(HttpServer.layerServices),
  );
  return HttpRouter.toWebHandler(routes, {
    disableLogger: true,
    routerConfig: { maxParamLength: fileRouterMaxParamLength },
  }).handler;
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
            store.approve(params.userCode, payload.machineName, payload.grant),
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
