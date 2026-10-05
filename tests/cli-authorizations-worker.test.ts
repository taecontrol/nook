import { beforeEach, expect, it } from 'vitest';
import { access, accessFixture } from './support/access.ts';
import {
  approve,
  createAuthorization,
  issueToken,
  jsonRequest,
  ownerRuntime,
} from './support/authorizations.ts';
import { responseHasTag } from './support/private-assertions.ts';
import { runtime, type TestRuntime } from './support/runtime.ts';

let app: TestRuntime;
beforeEach(async () => {
  app = await ownerRuntime(await runtime());
  return () => app.close();
});
it('the device response is short-lived, code-free in its URL, and pending polls reveal no credential', async () => {
  const pending = await createAuthorization(app);
  expect(pending.verificationUrl).toBe(`${app.origin}/cli/authorize`);
  expect(pending.expiresIn).toBe(600);
  expect(pending.interval).toBe(2);
  const row = await (await app.mf.getD1Database('DB'))
    .prepare('SELECT requested_at, expires_at FROM authorizations')
    .first();
  expect(Number(row?.expires_at) - Number(row?.requested_at)).toBe(600_000);
  expect(
    /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/.test(
      pending.userCode,
    ),
  ).toBe(true);
  expect(/^[A-Za-z0-9_-]{43}$/.test(pending.deviceCode)).toBe(true);
  const response = await jsonRequest(app, '/api/machine/token', {
    deviceCode: pending.deviceCode,
  });
  expect(response.status).toBe(400);
  expect(await responseHasTag(response, 'pending')).toBe(true);
});
it.each(['pending', 'approved', 'denied'])(
  'expiry takes precedence over the %s request state and owner writes leave it unchanged',
  async (status) => {
    const pending = await createAuthorization(app);
    const db = await app.mf.getD1Database('DB');
    await db
      .prepare('UPDATE authorizations SET status=?, expires_at=0')
      .bind(status)
      .run();
    for (const action of ['approve', 'deny']) {
      const response = await jsonRequest(
        app,
        `/api/authorizations/${pending.userCode}/${action}`,
        action === 'approve' ? { machineName: 'late-machine' } : undefined,
      );
      expect(response.status).toBe(410);
      expect(await responseHasTag(response, 'Expired', false)).toBe(true);
    }
    expect(
      await responseHasTag(
        await jsonRequest(app, '/api/machine/token', {
          deviceCode: pending.deviceCode,
        }),
        'expired',
      ),
    ).toBe(true);
    expect(
      (await db.prepare('SELECT status FROM authorizations').first())?.status,
    ).toBe(status);
  },
);
it('E11: pending requests are capped at twenty and expired rows are removed before creation', async () => {
  for (let i = 0; i < 20; i++) await createAuthorization(app);
  expect(
    (
      await jsonRequest(app, '/api/machine/authorizations', {
        suggestedName: 'twenty-first',
        client: 'nook test',
      })
    ).status,
  ).toBe(429);
  const db = await app.mf.getD1Database('DB');
  await db.prepare('UPDATE authorizations SET expires_at = 0').run();
  await createAuthorization(app);
  expect(
    (await db.prepare('SELECT count(*) AS count FROM authorizations').first())
      ?.count,
  ).toBe(1);
});
it('E13: every D1 table keeps only hashes of the token and device code', async () => {
  const pending = await createAuthorization(app);
  const issued = await issueToken(app);
  const db = await app.mf.getD1Database('DB');
  const tables = (
    await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name <> '_cf_METADATA'",
      )
      .all<{ name: string }>()
  ).results;
  for (const { name } of tables) {
    const rows = JSON.stringify(
      (await db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all())
        .results,
    );
    expect(
      rows.includes(issued.token),
      'Token must never be stored in plaintext',
    ).toBe(false);
    expect(
      rows.includes(pending.deviceCode),
      'Device code must never be stored in plaintext',
    ).toBe(false);
    expect(
      rows.includes(issued.deviceCode),
      'Redeemed device code must not remain',
    ).toBe(false);
  }
});
it('E14: user codes and invented device codes cannot redeem a token', async () => {
  const pending = await createAuthorization(app);
  expect((await approve(app, pending.userCode)).status).toBe(204);
  for (const deviceCode of [pending.userCode, 'invented-device-code']) {
    const response = await jsonRequest(app, '/api/machine/token', {
      deviceCode,
    });
    expect(response.status).toBe(400);
    expect(await responseHasTag(response, 'invalid')).toBe(true);
  }
});
it('E15: concurrent polls redeem exactly one token and all subsequent polls are invalid', async () => {
  const pending = await createAuthorization(app);
  expect((await approve(app, pending.userCode)).status).toBe(204);
  const polls = await Promise.all(
    [0, 1].map(() =>
      jsonRequest(app, '/api/machine/token', {
        deviceCode: pending.deviceCode,
      }),
    ),
  );
  expect(polls.map((response) => response.status).sort()).toEqual([200, 400]);
  const bodies = (await Promise.all(
    polls.map((response) => response.json()),
  )) as { token?: string; _tag?: string }[];
  expect(bodies.filter((body) => typeof body.token === 'string').length).toBe(
    1,
  );
  expect(bodies.filter((body) => body._tag === 'invalid').length).toBe(1);
  const later = await jsonRequest(app, '/api/machine/token', {
    deviceCode: pending.deviceCode,
  });
  expect(await responseHasTag(later, 'invalid')).toBe(true);
  expect(
    (
      await (
        await app.mf.getD1Database('DB')
      )
        .prepare('SELECT count(*) AS count FROM machine_tokens')
        .first()
    )?.count,
  ).toBe(1);
});
it('E16: concurrent approval and denial have exactly one winner', async () => {
  const pending = await createAuthorization(app);
  const responses = await Promise.all([
    approve(app, pending.userCode),
    jsonRequest(app, `/api/authorizations/${pending.userCode}/deny`),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([
    204, 409,
  ]);
  expect(
    await responseHasTag(
      responses.find((response) => response.status === 409),
      'AlreadyHandled',
      false,
    ),
  ).toBe(true);
  const response = await jsonRequest(app, '/api/machine/token', {
    deviceCode: pending.deviceCode,
  });
  expect([200, 400].includes(response.status)).toBe(true);
  const body = (await response.json()) as { token?: string; _tag?: string };
  expect(Boolean(body.token) !== (body._tag === 'denied')).toBe(true);
});
it('E17: approval trims names, rejects blank or overlong names, and allows duplicate machine names', async () => {
  const pending = await createAuthorization(app);
  for (const machineName of ['', '   ', 'x'.repeat(65)]) {
    const response = await approve(app, pending.userCode, machineName);
    expect(response.status).toBe(400);
    const error = (await response.json()) as { message?: string };
    expect(typeof error.message === 'string' && error.message.length > 0).toBe(
      true,
    );
  }
  expect((await approve(app, pending.userCode, '  duplicate  ')).status).toBe(
    204,
  );
  const first = await jsonRequest(app, '/api/machine/token', {
    deviceCode: pending.deviceCode,
  });
  const body = (await first.json()) as { machine?: string };
  expect(body.machine === 'duplicate').toBe(true);
  await issueToken(app, 'duplicate');
  expect(
    (
      await (
        await app.mf.getD1Database('DB')
      )
        .prepare(
          "SELECT count(*) AS count FROM machine_tokens WHERE machine_name='duplicate'",
        )
        .first()
    )?.count,
  ).toBe(2);
});
it('E18: synthetic owner credentials never authenticate machine identity or logout', async () => {
  for (const method of ['GET', 'DELETE']) {
    const response = await fetch(
      `${app.origin}/api/machine/${method === 'GET' ? 'whoami' : 'token'}`,
      { method },
    );
    expect(response.status).toBe(401);
  }
});
it('E18: Access assertions never authenticate machine identity or logout', async () => {
  const issuer = await accessFixture();
  const protectedApp = await runtime({
    bindings: access,
    outboundService: issuer.outboundService,
  });
  try {
    const assertion = await issuer.assertion();
    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(
        `${protectedApp.origin}/api/machine/${method === 'GET' ? 'whoami' : 'token'}`,
        { method, headers: { 'Cf-Access-Jwt-Assertion': assertion } },
      );
      expect(response.status).toBe(401);
    }
  } finally {
    await protectedApp.close();
  }
});
it('E18: Nook tokens cannot authenticate owner routes, MCP, or any bucket operation', async () => {
  const issued = await issueToken(app);
  await app.setBindings({});
  for (const [method, path, payload] of [
    ['GET', '/api/whoami'],
    ['GET', '/api/buckets'],
    ['POST', '/api/buckets', { path: 'personal/private' }],
    ['DELETE', '/api/buckets/me'],
    ['POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }],
    ['GET', `/api/authorizations/${issued.userCode}`],
    [
      'POST',
      `/api/authorizations/${issued.userCode}/approve`,
      { machineName: 'attack' },
    ],
    ['POST', `/api/authorizations/${issued.userCode}/deny`],
  ] as const) {
    const response = await jsonRequest(
      app,
      path,
      payload,
      { Authorization: `Bearer ${issued.token}` },
      method,
    );
    expect(response.status).toBe(401);
  }
  expect(
    (
      await (
        await app.mf.getD1Database('DB')
      )
        .prepare('SELECT path FROM buckets')
        .all()
    ).results,
  ).toEqual([{ path: 'me' }]);
});
it('E19: owner lookup, approval, and denial enforce Access identity and same-origin writes', async () => {
  const issuer = await accessFixture();
  const guarded = await runtime({
    bindings: access,
    outboundService: issuer.outboundService,
  });
  try {
    const request = await createAuthorization(guarded);
    const owner = await issuer.assertion();
    const other = await issuer.assertion({ email: 'other@nook.test' });
    for (const action of ['lookup', 'approve', 'deny']) {
      const path = `/api/authorizations/${request.userCode}${action === 'lookup' ? '' : `/${action}`}`;
      const method = action === 'lookup' ? 'GET' : 'POST';
      const payload =
        action === 'approve' ? { machineName: 'owner-machine' } : undefined;
      expect(
        (await jsonRequest(guarded, path, payload, {}, method)).status,
      ).toBe(401);
      expect(
        (
          await jsonRequest(
            guarded,
            path,
            payload,
            { 'Cf-Access-Jwt-Assertion': other },
            method,
          )
        ).status,
      ).toBe(403);
      if (action !== 'lookup')
        expect(
          (
            await jsonRequest(
              guarded,
              path,
              payload,
              {
                'Cf-Access-Jwt-Assertion': owner,
                Origin: 'https://foreign.nook.test',
              },
              method,
            )
          ).status,
        ).toBe(403);
    }
    const poll = await jsonRequest(guarded, '/api/machine/token', {
      deviceCode: request.deviceCode,
    });
    expect(await responseHasTag(poll, 'pending')).toBe(true);
  } finally {
    await guarded.close();
  }
});
it('issued tokens and machine identity preserve the all-bucket grant', async () => {
  const issued = await issueToken(app);
  expect(issued.grant === 'all').toBe(true);
  const response = await fetch(`${app.origin}/api/machine/whoami`, {
    headers: { Authorization: `Bearer ${issued.token}` },
  });
  expect(response.status).toBe(200);
  const identity = (await response.json()) as { grant?: unknown };
  expect(identity.grant === 'all').toBe(true);
});
it('owner lookup preserves the submitted metadata and advertised request lifetime', async () => {
  const before = Date.now();
  const response = await jsonRequest(app, '/api/machine/authorizations', {
    suggestedName: 'synthetic suggested name',
    client: 'synthetic runner',
  });
  const after = Date.now();
  expect(response.status).toBe(200);
  const pending = (await response.json()) as { userCode: string };
  const lookup = await jsonRequest(
    app,
    `/api/authorizations/${pending.userCode}`,
    undefined,
    {},
    'GET',
  );
  expect(lookup.status).toBe(200);
  const revealed = (await lookup.json()) as {
    suggestedName: string;
    client: string;
    requestedAt: string;
    expiresAt: string;
  };
  expect(revealed.suggestedName === 'synthetic suggested name').toBe(true);
  expect(revealed.client === 'synthetic runner').toBe(true);
  expect(
    Date.parse(revealed.expiresAt) - Date.parse(revealed.requestedAt),
  ).toBe(600_000);
  expect(
    Date.parse(revealed.requestedAt) >= before &&
      Date.parse(revealed.requestedAt) <= after,
    'The request starts when creation is observed',
  ).toBe(true);
  expect(
    Date.parse(revealed.expiresAt) >= before + 600_000 &&
      Date.parse(revealed.expiresAt) <= after + 600_000,
    'The request expires ten minutes after creation',
  ).toBe(true);
  expect(
    Object.keys(revealed).sort().join(',') ===
      'client,expiresAt,requestedAt,suggestedName',
  ).toBe(true);
});
it('malformed and overlong payloads return a fixed error without echoing a credential', async () => {
  const issued = await issueToken(app);
  for (const [path, payload] of [
    [
      '/api/machine/authorizations',
      { suggestedName: 'x'.repeat(65), client: 'nook test' },
    ],
    [
      '/api/machine/authorizations',
      { suggestedName: 'machine', client: 'x'.repeat(129) },
    ],
    ['/api/machine/token', { deviceCode: 'x'.repeat(129) }],
    ['/api/machine/token', { deviceCode: { value: issued.token } }],
    [
      `/api/authorizations/${issued.userCode}/approve`,
      { machineName: { value: issued.token } },
    ],
  ] as const) {
    const response = await jsonRequest(app, path, payload);
    expect(response.status).toBe(400);
    expect(
      (await response.clone().text()).includes(issued.token),
      'Schema errors never echo a token',
    ).toBe(false);
    expect(await responseHasTag(response, 'BadRequest')).toBe(true);
  }
});
it('malformed Bearers deny identity and revocation without mutating the token', async () => {
  const issued = await issueToken(app);
  for (const authorization of [
    `Basic ${issued.token}`,
    'Bearer nook-short',
    'Bearer',
    `Bearer ${issued.token} extra`,
  ]) {
    for (const [method, path] of [
      ['GET', 'whoami'],
      ['DELETE', 'token'],
    ] as const) {
      const response = await fetch(`${app.origin}/api/machine/${path}`, {
        method,
        headers: { Authorization: authorization },
      });
      expect(response.status).toBe(401);
      expect(await responseHasTag(response, 'Unauthorized')).toBe(true);
    }
  }
  expect(
    (
      await (
        await app.mf.getD1Database('DB')
      )
        .prepare('SELECT count(*) AS count FROM machine_tokens')
        .first()
    )?.count,
  ).toBe(1);
});
it('foreign Origin machine writes cannot create, exchange, or revoke credentials', async () => {
  const pending = await createAuthorization(app);
  const issued = await issueToken(app);
  for (const [method, path, payload] of [
    [
      'POST',
      '/api/machine/authorizations',
      { suggestedName: 'foreign', client: 'nook test' },
    ],
    ['POST', '/api/machine/token', { deviceCode: pending.deviceCode }],
    ['DELETE', '/api/machine/token', undefined],
  ] as const) {
    const response = await jsonRequest(
      app,
      path,
      payload,
      {
        Origin: 'https://foreign.nook.test',
        Authorization: `Bearer ${issued.token}`,
      },
      method,
    );
    expect(response.status).toBe(403);
    expect(await responseHasTag(response, 'Forbidden')).toBe(true);
  }
  const db = await app.mf.getD1Database('DB');
  expect(
    (await db.prepare('SELECT count(*) AS count FROM authorizations').first())
      ?.count,
  ).toBe(1);
  expect(
    (await db.prepare('SELECT count(*) AS count FROM machine_tokens').first())
      ?.count,
  ).toBe(1);
});
