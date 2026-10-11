import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  matches,
  ownerRoutes,
  type Route,
  revealRoute,
  tokenRoutes,
} from '../apps/worker/src/routes.ts';
import { MachineApi } from '../packages/contract/src/index.ts';
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

const listed = (routes: readonly Route[]) =>
  routes.map(({ method, path }) => `${method} ${path}`);
const concrete = (path: string) => path.replace(/:[^/]+/g, 'x');
const notFound = '{"error":"Not found"}';

// A new endpoint changes these lists, so its gate and token check get review.
it('derives the owner gate and the machine token check from the contract', () => {
  expect(listed(ownerRoutes)).toEqual([
    'GET /api/memories/search',
    'GET /api/memories/counts',
    'GET /api/memories',
    'GET /api/memories/:id',
    'GET /api/audit',
    'GET /api/whoami',
    'GET /api/buckets',
    'POST /api/buckets',
    'DELETE /api/buckets/:path',
    'POST /api/secrets/:path/reveal',
    'GET /api/secrets',
    'POST /api/secrets',
    'PUT /api/secrets/:path',
    'DELETE /api/secrets/:path',
    'GET /api/machines',
    'DELETE /api/machines/:id',
  ]);
  expect(listed(tokenRoutes)).toEqual([
    'GET /api/machine/whoami',
    'GET /api/machine/secrets',
    'POST /api/machine/secrets',
    'POST /api/machine/secrets/values',
    'DELETE /api/machine/token',
  ]);
  const machineRoutes = listed(
    Object.values(MachineApi.groups).flatMap((group) =>
      Object.values(group.endpoints),
    ),
  );
  const token = listed(tokenRoutes);
  expect(machineRoutes.filter((entry) => !token.includes(entry))).toEqual([
    'POST /api/machine/authorizations',
    'POST /api/machine/token',
  ]);
  expect(listed([revealRoute])).toEqual(['POST /api/secrets/:path/reveal']);
});

it.each([
  ['DELETE', '/api/buckets/work%2Facme', true],
  ['DELETE', '/api/buckets/work/acme', false],
  ['DELETE', '/api/buckets/', false],
  ['DELETE', '/api/buckets', false],
  ['GET', '/api/buckets/', false],
  ['GET', '/API/BUCKETS', false],
  ['HEAD', '/api/buckets', true],
  ['HEAD', '/api/memories/x', true],
  ['POST', '/api/memories/x', false],
  ['GET', '/api/memories/x/y', false],
  ['POST', '/api/secrets/work%2FKEY/reveal', true],
  ['PUT', '/api/secrets/work%2FKEY/reveal', false],
  ['POST', '/api/secrets/work/KEY/reveal', false],
] as const)(
  'matches %s %s against the owner routes: %s',
  (method, path, known) => {
    expect(matches(ownerRoutes, method, path)).toBe(known);
  },
);

it('lets every owner endpoint past the gate and answers the rest with a JSON 404', async () => {
  const headers = { 'Cf-Access-Jwt-Assertion': await issuer.assertion() };
  for (const { method, path } of ownerRoutes) {
    const response = await fetch(`${app.origin}${concrete(path)}`, {
      method,
      headers,
    });
    expect(await response.text(), `${method} ${path}`).not.toBe(notFound);
  }
  for (const [method, path] of [
    ['GET', '/api/unknown'],
    ['GET', '/api/whoami/'],
    ['GET', '/api/WHOAMI'],
    ['POST', '/api/whoami'],
    ['PATCH', '/api/buckets'],
    ['GET', '/api/buckets/work'],
    ['DELETE', '/api/buckets/work/acme'],
    ['POST', '/api/machines'],
    ['GET', '/api/secrets/work%2FKEY'],
    ['GET', '/api/secrets/work%2FKEY/reveal'],
    ['DELETE', '/api/secrets/work%2FKEY/reveal'],
    ['POST', '/api/secrets/work/KEY/reveal'],
    ['POST', '/api/memories/search'],
    ['GET', '/api/memories/x/y'],
  ]) {
    const response = await fetch(`${app.origin}${path}`, { method, headers });
    expect(response.status, `${method} ${path}`).toBe(404);
    expect(response.headers.get('Content-Type')).toMatch(/application\/json/);
    expect(await response.text()).toBe(notFound);
  }
});

it('serves HEAD on every owner read as the router serves GET', async () => {
  const headers = { 'Cf-Access-Jwt-Assertion': await issuer.assertion() };
  for (const [path, status] of [
    ['/api/whoami', 200],
    ['/api/buckets', 200],
    ['/api/machines', 200],
    ['/api/secrets', 200],
    ['/api/audit', 200],
    ['/api/memories/counts', 200],
    ['/api/memories/search', 400],
    ['/api/memories', 400],
    ['/api/memories/x', 404],
    ['/api/unknown', 404],
  ] as const) {
    const response = await fetch(`${app.origin}${path}`, {
      method: 'HEAD',
      headers,
    });
    expect(response.status, path).toBe(status);
  }
});

it('answers every token endpoint without Authorization with 401 before routing', async () => {
  for (const { method, path } of tokenRoutes) {
    const response = await fetch(`${app.origin}${concrete(path)}`, {
      method,
      headers: { Origin: 'https://foreign.test' },
    });
    expect(response.status, `${method} ${path}`).toBe(401);
    expect(await response.json()).toEqual({ _tag: 'Unauthorized' });
  }
  for (const [method, path, status] of [
    ['HEAD', '/api/machine/whoami', 401],
    ['HEAD', '/api/machine/secrets', 401],
    ['POST', '/api/machine/whoami', 404],
    ['GET', '/api/machine/token', 404],
    ['PUT', '/api/machine/secrets', 404],
    ['GET', '/api/machine/secrets/values', 404],
    ['DELETE', '/api/machine/secrets/work%2FKEY', 404],
    ['GET', '/api/machine/unknown', 404],
    ['POST', '/api/machine/authorizations', 400],
    ['POST', '/api/machine/token', 400],
  ] as const) {
    const response = await fetch(`${app.origin}${path}`, { method });
    expect(response.status, `${method} ${path}`).toBe(status);
  }
});
