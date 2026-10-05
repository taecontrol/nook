import { generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { access, accessFixture } from './support/access.ts';
import { fetchWithHost, runtime, type TestRuntime } from './support/runtime.ts';

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

async function request(path: string, token?: string) {
  return fetch(`${app.origin}${path}`, {
    headers: token ? { 'Cf-Access-Jwt-Assertion': token } : {},
  });
}

describe('E1: Access identity through HTTP to the built Worker in workerd', () => {
  it('denies a missing assertion', async () => {
    expect((await request('/api/whoami')).status).toBe(401);
  });
  it('denies malformed assertions', async () => {
    expect((await request('/api/whoami', 'malformed')).status).toBe(401);
  });
  it('denies assertions with an invalid signature', async () => {
    const otherKey = await generateKeyPair('RS256');
    expect(
      (
        await request(
          '/api/whoami',
          await issuer.assertion({}, { signer: otherKey.privateKey }),
        )
      ).status,
    ).toBe(401);
  });
  it('denies assertions naming an unknown key', async () => {
    expect(
      (
        await request(
          '/api/whoami',
          await issuer.assertion({}, { kid: 'unknown' }),
        )
      ).status,
    ).toBe(401);
  });
  it.each([
    ['expired', { exp: 1 }],
    ['wrong audience', { aud: 'another-app' }],
    ['wrong issuer', { iss: 'https://another-issuer.test' }],
    ['missing expiry', { exp: undefined }],
    ['missing email', { email: undefined }],
    ['missing subject', { sub: undefined }],
  ])('denies %s claims', async (_name, claims) => {
    expect(
      (await request('/api/whoami', await issuer.assertion(claims))).status,
    ).toBe(401);
  });
  it('denies another identity without naming either email in the body', async () => {
    const other = 'other@nook.test';
    const response = await request(
      '/api/whoami',
      await issuer.assertion({ email: other }),
    );
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).not.toContain('@');
    expect(body).not.toContain(access.OWNER_EMAIL);
    expect(body).not.toContain(other);
  });
  it('returns exactly the verified owner email', async () => {
    const response = await request('/api/whoami', await issuer.assertion());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: access.OWNER_EMAIL });
  });
  it('returns the contract denial tags over the real Worker HTTP boundary', async () => {
    const unauthorized = await request('/api/whoami');
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ _tag: 'Unauthorized' });
    const forbidden = await request(
      '/api/whoami',
      await issuer.assertion({ email: 'other@nook.test' }),
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ _tag: 'Forbidden' });
  });
  it.each(['RS384', 'RS512'] as const)(
    'denies a correctly signed %s assertion with matching claims and JWKS',
    async (algorithm) => {
      const alternate = await accessFixture({ algorithm });
      const isolate = await runtime({
        bindings: access,
        outboundService: alternate.outboundService,
      });
      try {
        const response = await fetch(`${isolate.origin}/api/whoami`, {
          headers: { 'Cf-Access-Jwt-Assertion': await alternate.assertion() },
        });
        expect(response.status).toBe(401);
      } finally {
        await isolate.close();
      }
    },
  );
  it('denies an HTTP issuer even when its assertion and JWKS match', async () => {
    const insecureIssuer = 'http://access.nook.test';
    const insecure = await accessFixture({ issuer: insecureIssuer });
    const isolate = await runtime({
      bindings: { ...access, ACCESS_ISSUER: insecureIssuer },
      outboundService: insecure.outboundService,
    });
    try {
      const response = await fetch(`${isolate.origin}/api/whoami`, {
        headers: { 'Cf-Access-Jwt-Assertion': await insecure.assertion() },
      });
      expect(response.status).toBe(401);
      expect(insecure.fetched).toEqual([]);
    } finally {
      await isolate.close();
    }
  });
  it.each(['ACCESS_ISSUER', 'ACCESS_AUDIENCE', 'OWNER_EMAIL'])(
    'fails closed when %s is missing',
    async (missing) => {
      const bindings = { ...access };
      delete bindings[missing as keyof typeof bindings];
      const unconfigured = await runtime({
        bindings,
        outboundService: issuer.outboundService,
      });
      try {
        for (const token of [undefined, await issuer.assertion()]) {
          const response = await fetch(`${unconfigured.origin}/api/whoami`, {
            headers: token ? { 'Cf-Access-Jwt-Assertion': token } : {},
          });
          expect(response.status).toBe(401);
        }
      } finally {
        await unconfigured.close();
      }
    },
  );
  it('allows a synthetic owner only on the configured loopback origin', async () => {
    const local = await runtime({
      bindings: { LOCAL_OWNER: 'synthetic-owner' },
    });
    try {
      await local.setBindings({
        LOCAL_OWNER: 'synthetic-owner',
        LOCAL_ORIGIN: local.origin,
      });
      const response = await fetch(`${local.origin}/api/whoami`, {
        headers: { Origin: local.origin },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ email: 'owner@nook.test' });
      const alternateHeaders: Record<string, string>[] = [
        { Host: 'nook.remote.test' },
        { Origin: 'https://nook.remote.test' },
        { Origin: `${local.origin}/other` },
      ];
      for (const headers of alternateHeaders) {
        const response =
          'Host' in headers
            ? await fetchWithHost(`${local.origin}/api/whoami`, headers.Host)
            : await fetch(`${local.origin}/api/whoami`, { headers });
        expect(response.status).toBe(401);
      }
      await local.setBindings({
        LOCAL_OWNER: 'synthetic-owner',
        LOCAL_ORIGIN: 'http://127.0.0.1:1',
      });
      expect((await fetch(`${local.origin}/api/whoami`)).status).toBe(401);
    } finally {
      await local.close();
    }
  });
  it('falls back to real Access validation when a synthetic owner has the wrong origin', async () => {
    const local = await runtime({
      bindings: {
        ...access,
        LOCAL_OWNER: 'synthetic-owner',
        LOCAL_ORIGIN: 'http://127.0.0.1:1',
      },
      outboundService: issuer.outboundService,
    });
    try {
      const response = await fetch(`${local.origin}/api/whoami`, {
        headers: {
          'Cf-Access-Jwt-Assertion': await issuer.assertion({
            email: 'other@nook.test',
          }),
        },
      });
      expect(response.status).toBe(403);
    } finally {
      await local.close();
    }
  });
  it('requires the synthetic-owner marker even when the local origin matches', async () => {
    const local = await runtime();
    try {
      for (const marker of [undefined, 'another-value']) {
        await local.setBindings({
          LOCAL_ORIGIN: local.origin,
          ...(marker ? { LOCAL_OWNER: marker } : {}),
        });
        expect((await fetch(`${local.origin}/api/whoami`)).status).toBe(401);
      }
    } finally {
      await local.close();
    }
  });
  it('rejects a remote hostname even when LOCAL_ORIGIN matches that hostname', async () => {
    const local = await runtime({
      bindings: {
        LOCAL_OWNER: 'synthetic-owner',
        LOCAL_ORIGIN: 'http://nook.remote.test',
      },
    });
    try {
      const response = await fetchWithHost(
        `${local.origin}/api/whoami`,
        'nook.remote.test',
      );
      expect(response.status).toBe(401);
    } finally {
      await local.close();
    }
  });
});

it('E2: concurrent and warm owner requests share one JWKS fetch in an isolate', async () => {
  const fresh = await accessFixture();
  const isolate = await runtime({
    bindings: access,
    outboundService: fresh.outboundService,
  });
  try {
    const token = await fresh.assertion();
    const send = () =>
      fetch(`${isolate.origin}/api/whoami`, {
        headers: { 'Cf-Access-Jwt-Assertion': token },
      });
    const cold = await Promise.all(Array.from({ length: 8 }, send));
    const warm = await Promise.all(Array.from({ length: 8 }, send));
    expect([...cold, ...warm].map((response) => response.status)).toEqual(
      Array(16).fill(200),
    );
    expect(fresh.fetched).toEqual([
      `${access.ACCESS_ISSUER}/cdn-cgi/access/certs`,
    ]);
  } finally {
    await isolate.close();
  }
});

it('E2: a failed JWKS fetch denies the request and a later healthy fetch recovers', async () => {
  const fresh = await accessFixture();
  let attempts = 0;
  const isolate = await runtime({
    bindings: access,
    outboundService: async (request) => {
      attempts++;
      return attempts === 1
        ? new Response('Unavailable', { status: 503 })
        : fresh.outboundService(request);
    },
  });
  try {
    const token = await fresh.assertion();
    const send = () =>
      fetch(`${isolate.origin}/api/whoami`, {
        headers: { 'Cf-Access-Jwt-Assertion': token },
      });
    expect((await send()).status).toBe(401);
    expect((await send()).status).toBe(200);
    expect(attempts).toBe(2);
  } finally {
    await isolate.close();
  }
});

it('E3: authenticates MCP before rejecting an unsupported GET', async () => {
  expect((await request('/mcp')).status).toBe(401);
  expect((await request('/mcp', await issuer.assertion())).status).toBe(405);
});

it('E4: authenticates unknown API paths and returns a JSON 404 to the owner', async () => {
  expect((await request('/api/buckets/personal')).status).toBe(401);
  const response = await request(
    '/api/buckets/personal',
    await issuer.assertion(),
  );
  expect(response.status).toBe(404);
  expect(response.headers.get('Content-Type')).toMatch(/application\/json/);
  expect(await response.json()).toEqual({ error: 'Not found' });
});
