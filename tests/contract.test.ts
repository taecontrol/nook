import { QueryClient } from '@tanstack/react-query';
import { Effect } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';
import { HttpApiClient } from 'effect/http-api';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { identityOptions } from '../apps/web/src/identity.ts';
import { Api } from '../packages/contract/src/index.ts';
import { access, accessFixture } from './support/access.ts';
import { runtime, type TestRuntime } from './support/runtime.ts';

let issuer: Awaited<ReturnType<typeof accessFixture>>;
let app: TestRuntime;
beforeAll(async () => {
  issuer = await accessFixture();
  app = await runtime({
    bindings: access,
    outboundService: issuer.outboundService,
  });
});
afterAll(async () => {
  await app?.close();
});

it.each([
  ['Unauthorized', undefined],
  ['Forbidden', 'other@nook.test'],
])(
  'the derived contract client decodes the Worker %s error',
  async (tag, email) => {
    const token = email ? await issuer.assertion({ email }) : undefined;
    const denial = Effect.gen(function* () {
      const client = yield* HttpApiClient.make(Api, {
        baseUrl: app.origin,
        transformClient: (http) =>
          token
            ? HttpClient.mapRequest(
                http,
                HttpClientRequest.setHeader('Cf-Access-Jwt-Assertion', token),
              )
            : http,
      });
      return yield* Effect.flip(client.session.whoami());
    }).pipe(Effect.provide(FetchHttpClient.layer));
    expect(await Effect.runPromise(denial)).toMatchObject({ _tag: tag });
  },
);

it('E13: the real QueryClient reuses the derived identity request on subsequent fetches', async () => {
  const queryClient = new QueryClient();
  const actualFetch = globalThis.fetch;
  const token = await issuer.assertion();
  const requests: string[] = [];
  const proxy = createServer(async (request, response) => {
    requests.push(request.url ?? '/');
    const owner = await actualFetch(`${app.origin}${request.url}`, {
      headers: { 'Cf-Access-Jwt-Assertion': token },
    });
    response.writeHead(owner.status, { 'Content-Type': 'application/json' });
    response.end(await owner.text());
  });
  // The proxy holds its port continuously and forwards to the real Worker.
  await new Promise<void>((accept) => proxy.listen(0, '127.0.0.1', accept));
  const origin = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  vi.stubGlobal('location', new URL(origin));
  try {
    expect(await queryClient.fetchQuery(identityOptions)).toEqual({
      state: 'signed-in',
      email: access.OWNER_EMAIL,
    });
    expect(await queryClient.fetchQuery(identityOptions)).toEqual({
      state: 'signed-in',
      email: access.OWNER_EMAIL,
    });
    expect(requests).toEqual(['/api/whoami']);
  } finally {
    queryClient.clear();
    vi.unstubAllGlobals();
    await new Promise<void>((accept, reject) =>
      proxy.close((error) => (error ? reject(error) : accept())),
    );
  }
});

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
