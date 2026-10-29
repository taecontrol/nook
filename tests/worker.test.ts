import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Readable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import { decodeJwt, generateKeyPair } from 'jose';
import { Log, LogLevel } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { access, accessFixture } from './support/access.ts';
import { fetchWithHost, runtime } from './support/runtime.ts';

let issuer: Awaited<ReturnType<typeof accessFixture>>;
let app: Awaited<ReturnType<typeof loggedRuntime>>;
const vaultKey = randomBytes(32).toString('base64');
const rejections: { logs: string; privateValues: string[] }[] = [];

async function loggedRuntime(options: Parameters<typeof runtime>[0] = {}) {
  const bindings = { VAULT_KEY: vaultKey, ...options.bindings };
  const app = await runtime({ ...options, bindings });
  const logs: string[] = [];
  const workerLogs: string[] = [];
  const workerStdio: Readable[] = [];
  class AuthLog extends Log {
    override log(message: string) {
      logs.push(message);
    }
  }
  await app.setBindings(bindings, {
    log: new AuthLog(LogLevel.VERBOSE),
    handleRuntimeStdio(stdout, stderr) {
      workerStdio.splice(0, workerStdio.length, stdout, stderr);
      for (const stream of [stdout, stderr])
        stream.on('data', (chunk) => {
          logs.push(chunk.toString());
          workerLogs.push(chunk.toString());
        });
    },
  });
  return { ...app, logs, workerLogs, workerStdio };
}

// Stdout chunks can split a line, and workerd may flush it after the response.
async function completeWorkerOutput(target: { workerLogs: string[] }) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const output = target.workerLogs.join('');
    if (output.trim() && output.endsWith('\n')) return output;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return target.workerLogs.join('');
}

function rejectionLines(logs: string[]) {
  return logs
    .join('')
    .split(/\r?\n/)
    .filter((line) => line.includes('auth-rejected'));
}

async function expectRejection(
  target: typeof app,
  token: string | undefined,
  reason: string,
  {
    status = 401,
    extra = {},
    path = '/api/whoami',
    method = 'GET',
  }: {
    status?: 401 | 403;
    extra?: Record<string, unknown>;
    path?: string;
    method?: string;
  } = {},
) {
  const query = `private-query=${randomUUID()}`;
  target.logs.length = 0;
  target.workerLogs.length = 0;
  const response = await fetch(`${target.origin}${path}?${query}`, {
    method,
    headers: token ? { 'Cf-Access-Jwt-Assertion': token } : {},
  });
  expect(response.status).toBe(status);
  expect(await response.text()).toBe(
    status === 401 ? '{"_tag":"Unauthorized"}' : '{"_tag":"Forbidden"}',
  );
  const output = await completeWorkerOutput(target);
  let claims: Record<string, unknown> = {};
  try {
    if (token) claims = decodeJwt(token);
  } catch {
    // Malformed JWS has no readable claims; its full text is still private.
  }
  rejections.push({
    logs: [...target.logs, output].join('\n'),
    privateValues: [
      ...Object.values(access),
      vaultKey,
      query,
      ...(token ? [token, ...token.split('.')] : []),
      ...['email', 'sub', 'iss', 'aud'].flatMap((name) => {
        const value = claims[name];
        return typeof value === 'string'
          ? [value]
          : ((value as string[]) ?? []);
      }),
    ],
  });
  const lines = rejectionLines([output]);
  expect(lines.length, 'E5: exactly one rejection line per request').toBe(1);
  expect(
    output.trim().split(/\r?\n/).length,
    'E5: no additional Worker log lines, including raw verifier or fetch errors',
  ).toBe(1);
  let logged: unknown;
  try {
    const line = lines[0];
    logged = JSON.parse(
      line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1),
    );
  } catch {
    // Keep the diagnostic private even when a regression emits invalid JSON.
  }
  expect(
    isDeepStrictEqual(logged, {
      event: 'auth-rejected',
      reason,
      method,
      path,
      ...extra,
    }),
    'E5: the rejection line contains exactly the public fields',
  ).toBe(true);
}

beforeAll(async () => {
  issuer = await accessFixture();
  app = await loggedRuntime({
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

describe('E1 / installation E5: Access identity through HTTP to the built Worker in workerd', () => {
  it('denies a missing assertion', async () => {
    await expectRejection(app, undefined, 'no-assertion');
  });
  it('denies malformed assertions', async () => {
    await expectRejection(
      app,
      randomBytes(32).toString('hex'),
      'malformed-assertion',
    );
  });
  it('denies assertions with an invalid signature', async () => {
    const otherKey = await generateKeyPair('RS256');
    await expectRejection(
      app,
      await issuer.assertion({}, { signer: otherKey.privateKey }),
      'invalid-signature',
    );
  });
  it('denies assertions naming an unknown key', async () => {
    await expectRejection(
      app,
      await issuer.assertion({}, { kid: 'unknown' }),
      'unknown-key',
    );
  });
  it.each([
    ['expired', { exp: 1 }, 'expired', {}],
    ['future not-before', { nbf: 4_102_444_800 }, 'not-yet-valid', {}],
    ['wrong audience', { aud: 'another-app' }, 'audience-mismatch', {}],
    [
      'wrong issuer',
      { iss: 'https://another-issuer.test' },
      'issuer-mismatch',
      {},
    ],
    ['missing expiry', { exp: undefined }, 'missing-claim', { claim: 'exp' }],
    [
      'missing email',
      { email: undefined },
      'missing-claim',
      { claim: 'email' },
    ],
    ['missing subject', { sub: undefined }, 'missing-claim', { claim: 'sub' }],
  ] as const)('denies %s claims', async (_name, claims, reason, extra) => {
    await expectRejection(app, await issuer.assertion(claims), reason, {
      extra,
    });
  });
  it('denies another identity without naming either email in the body', async () => {
    const other = 'other@nook.test';
    await expectRejection(
      app,
      await issuer.assertion({ email: other }),
      'not-owner',
      {
        status: 403,
      },
    );
    // Deliver any follow-up request's real workerd output during E7 instead.
    for (const stream of app.workerStdio) stream.pause();
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
  it('E7: returns exactly the verified owner email without a rejection log', async () => {
    app.logs.length = 0;
    for (const stream of app.workerStdio) stream.resume();
    const response = await request('/api/whoami', await issuer.assertion());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: access.OWNER_EMAIL });
    expect(rejectionLines(app.logs).length).toBe(0);
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
      const isolate = await loggedRuntime({
        bindings: access,
        outboundService: alternate.outboundService,
      });
      try {
        await expectRejection(
          isolate,
          await alternate.assertion(),
          'algorithm-not-allowed',
        );
      } finally {
        await isolate.close();
      }
    },
  );
  it('denies an HTTP issuer even when its assertion and JWKS match', async () => {
    const insecureIssuer = 'http://access.nook.test';
    const insecure = await accessFixture({ issuer: insecureIssuer });
    const isolate = await loggedRuntime({
      bindings: { ...access, ACCESS_ISSUER: insecureIssuer },
      outboundService: insecure.outboundService,
    });
    try {
      await expectRejection(
        isolate,
        await insecure.assertion(),
        'issuer-not-https',
      );
      expect(insecure.fetched).toEqual([]);
    } finally {
      await isolate.close();
    }
  });
  it.each(
    [
      ['ACCESS_ISSUER'],
      ['ACCESS_AUDIENCE'],
      ['OWNER_EMAIL'],
      ['ACCESS_ISSUER', 'ACCESS_AUDIENCE', 'OWNER_EMAIL'],
    ].map((settings) => [settings]),
  )('fails closed when configuration is missing: %j', async (missing) => {
    const bindings = { ...access };
    for (const name of missing) delete bindings[name as keyof typeof bindings];
    const unconfigured = await loggedRuntime({
      bindings,
      outboundService: issuer.outboundService,
    });
    try {
      for (const token of [undefined, await issuer.assertion()]) {
        await expectRejection(unconfigured, token, 'missing-config', {
          extra: { settings: [...missing].sort() },
        });
      }
    } finally {
      await unconfigured.close();
    }
  });
  it('E7: allows a synthetic owner without a rejection log only on the configured loopback origin', async () => {
    const local = await loggedRuntime({
      bindings: { LOCAL_OWNER: 'synthetic-owner' },
    });
    try {
      await local.setBindings({
        LOCAL_OWNER: 'synthetic-owner',
        LOCAL_ORIGIN: local.origin,
      });
      local.logs.length = 0;
      const response = await fetch(`${local.origin}/api/whoami`, {
        headers: { Origin: local.origin },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ email: 'owner@nook.test' });
      expect(rejectionLines(local.logs).length).toBe(0);
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

it.each(['http', 'network'] as const)(
  'E2 / installation E5: a failed %s JWKS fetch denies the request and a later healthy fetch recovers',
  async (failure) => {
    const fresh = await accessFixture();
    let attempts = 0;
    let failing = true;
    const server = createServer(async (request, response) => {
      attempts++;
      if (failing) {
        if (failure === 'network') response.destroy();
        else response.writeHead(503).end(Object.values(access).join(' '));
        return;
      }
      const result = await fresh.outboundService(
        new Request(new URL(request.url ?? '/', access.ACCESS_ISSUER)),
      );
      response.writeHead(result.status).end(await result.text());
    });
    await new Promise<void>((accept) => server.listen(0, '127.0.0.1', accept));
    const address = server.address();
    if (typeof address !== 'object' || !address)
      throw new Error('Synthetic JWKS server unavailable');
    let isolate: Awaited<ReturnType<typeof loggedRuntime>> | undefined;
    try {
      isolate = await loggedRuntime({
        bindings: access,
        outboundService: {
          external: { address: `127.0.0.1:${address.port}`, http: {} },
        },
      });
      const token = await fresh.assertion();
      const origin = isolate.origin;
      const send = () =>
        fetch(`${origin}/api/whoami`, {
          headers: { 'Cf-Access-Jwt-Assertion': token },
        });
      await expectRejection(isolate, token, 'certs-unavailable');
      failing = false;
      expect((await send()).status).toBe(200);
      expect(attempts).toBe(2);
    } finally {
      await isolate?.close();
      await new Promise<void>((accept) => {
        server.close(() => accept());
        server.closeAllConnections();
      });
    }
  },
);

it('E3: authenticates MCP before rejecting an unsupported GET', async () => {
  await expectRejection(app, undefined, 'no-assertion', {
    path: '/mcp',
    method: 'POST',
  });
  expect((await request('/mcp', await issuer.assertion())).status).toBe(405);
});

it('installation E6: every Access rejection keeps assertions, claim values, settings and query strings out of all logs', () => {
  expect(rejections.length).toBeGreaterThan(0);
  for (const { logs, privateValues } of rejections)
    expect(
      privateValues.some((value) => value.length > 0 && logs.includes(value)),
      'E6: private request and configuration values never enter logs',
    ).toBe(false);
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
