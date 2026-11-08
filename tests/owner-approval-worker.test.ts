import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it } from 'vitest';
import { access, accessFixture } from './support/access.ts';
import { machineCreate, machineCreateInput } from './support/agent-create.ts';
import {
  acmePath,
  auditPageData,
  auditRows,
  fetchValues,
} from './support/audit.ts';
import { jsonRequest } from './support/authorizations.ts';
import { issueGrant, machineMcp } from './support/grants.ts';
import { deferred, listMachines } from './support/machines.ts';
import {
  age,
  approvalFixture,
  ask,
  cloudflare,
  database,
  decide,
  mark,
  pending,
  requests,
  setMark,
  stripe,
  view,
  withdraw,
} from './support/owner-approval.ts';
import { expectNoValue } from './support/vault.ts';

let app: Awaited<ReturnType<typeof approvalFixture>>;
beforeEach(async () => {
  app = await approvalFixture();
  return () => app.close();
});
it('E1: unmarked delivery keeps its response, audit and statement budget without an approval row', async () => {
  const labels: string[] = [];
  const observed = await approvalFixture(async (label) => {
    labels.push(label);
    return true;
  });
  try {
    labels.length = 0;
    const response = await fetchValues(observed, observed.token, {
      approval: { attemptId: randomUUID() },
    });
    expect(await response.json()).toEqual({
      values: [{ path: acmePath, value: observed.input.value }],
    });
    expect(labels.filter((l) => l === '/statement')).toHaveLength(1);
    expect(labels.filter((l) => l === '/before-batch')).toHaveLength(2);
    expect((await auditRows(observed)).map((r) => r.outcome)).toEqual([
      'delivered',
    ]);
    expect(await requests(observed)).toEqual([]);
  } finally {
    await observed.close();
  }
});
it('E2: bucket marks cover descendants without matching siblings and secret marks match exactly', async () => {
  await setMark(app, 'work/acme');
  for (const path of [stripe, database])
    expect(
      (await pending(app, app.token, randomUUID(), { secrets: [path] })).paths,
    ).toEqual([path]);
  expect(
    await (
      await ask(app, app.token, randomUUID(), { secrets: ['work/acme2/TOKEN'] })
    ).json(),
  ).toHaveProperty('values');
  await setMark(app, 'work');
  expect(
    (
      await pending(app, app.token, randomUUID(), {
        secrets: ['work/acme2/TOKEN'],
      })
    ).paths,
  ).toEqual(['work/acme2/TOKEN']);
  await setMark(app, cloudflare, 'secret');
  expect(
    (await pending(app, app.token, randomUUID(), { secrets: [cloudflare] }))
      .paths,
  ).toEqual([cloudflare]);
});
it('E4: deleting and recreating an empty marked bucket keeps its orphan mark', async () => {
  await setMark(app, 'work/acme/empty');
  const mcp = machineMcp(app, app.token);
  await mcp.call('create_bucket', { path: 'work/acme/empty' });
  expect(
    (await mcp.call('delete_bucket', { path: 'work/acme/empty' })).isError,
  ).not.toBe(true);
  expect(
    await (await fetch(`${app.origin}/api/ask-first`)).json(),
  ).toMatchObject({
    marks: [{ kind: 'bucket', path: 'work/acme/empty', exists: false }],
  });
  await mcp.call('create_bucket', { path: 'work/acme/empty' });
  await machineCreate(
    app,
    app.token,
    machineCreateInput({ bucket: 'work/acme/empty', name: 'NEW_KEY' }),
  );
  await pending(app, app.token, randomUUID(), {
    secrets: ['work/acme/empty/NEW_KEY'],
  });
});
it('E5: only Access may read marks or decide', async () => {
  await setMark(app);
  const issuer = await accessFixture();
  await app.setBindings(
    { ...access, VAULT_KEY: app.key },
    { outboundService: issuer.outboundService },
  );
  for (const [path, method, body] of [
    ['/api/ask-first', 'GET'],
    ['/api/ask-first/bucket/work', 'PUT'],
    ['/api/ask-first/bucket/work', 'DELETE'],
    ['/api/approvals', 'GET'],
    ['/api/approvals/id', 'GET'],
    ['/api/approvals/id/approve', 'POST', { remember: 'once' }],
    ['/api/approvals/id/deny', 'POST'],
  ] as const)
    expect(
      (
        await jsonRequest(
          app,
          path,
          body,
          { Authorization: `Bearer ${app.token}` },
          method,
        )
      ).status,
    ).toBe(401);
});
it('E6/E7: a covered request stores the reported claim and audits the owner decision and exact delivery', async () => {
  await app.setBindings(app.bindings, { cf: { country: 'AR' } });
  await setMark(app);
  const id = randomUUID();
  const claim = { agent: 'claude-code', session: 's1' };
  const request = await pending(app, app.token, id, {
    secrets: [acmePath],
    agentSession: claim,
  });
  expect(request).toMatchObject({
    url: `${app.origin}/approvals/${request.id}`,
    paths: [acmePath],
    interval: 2,
  });
  expect(request.expiresIn).toBeGreaterThan(590);
  expect(await view(app, request.id)).toMatchObject({
    state: 'pending',
    claimed: { session: claim },
  });
  expect((await decide(app, request.id)).status).toBe(200);
  expect(
    await (
      await ask(app, app.token, id, {
        secrets: [acmePath],
        agentSession: claim,
      })
    ).json(),
  ).toEqual({ values: [{ path: acmePath, value: app.input.value }] });
  const rows = (await auditPageData(app)).entries;
  expect(rows.map((r) => r.outcome).sort()).toEqual([
    'approval_granted',
    'approval_requested',
    'delivered',
  ]);
  expect(rows.find((r) => r.outcome === 'approval_granted')).toMatchObject({
    ip: '203.0.113.42',
    country: 'AR',
    approval: { id: request.id, remember: 'once' },
  });
  expect(rows.find((r) => r.outcome === 'delivered')).toMatchObject({
    approval: { id: request.id, remember: 'once' },
  });
});
it('E8: owner denial refuses the attempt and never returns a value', async () => {
  await setMark(app);
  const id = randomUUID();
  const request = await pending(app, app.token, id);
  expect((await decide(app, request.id, 'deny')).status).toBe(200);
  const response = await ask(app, app.token, id);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    _tag: 'ApprovalDenied',
    paths: [stripe],
  });
  expect((await auditRows(app)).some((r) => r.outcome === 'delivered')).toBe(
    false,
  );
});
it('E9: ten minutes without a decision expires both the attempt and the owner view', async () => {
  await setMark(app);
  const id = randomUUID();
  const request = await pending(app, app.token, id);
  await age(app, request.id, 'expires_at', 600_001);
  expect((await ask(app, app.token, id)).status).toBe(410);
  expect(await view(app, request.id)).toMatchObject({ state: 'expired' });
});
it('E10: withdrawal is machine scoped, audited once, and prevents a later owner decision', async () => {
  await setMark(app);
  const request = await pending(app, app.token);
  const foreign = await issueGrant(app);
  expect((await withdraw(app, foreign.token, request.id)).status).toBe(204);
  expect(await view(app, request.id)).toMatchObject({ state: 'pending' });
  expect((await withdraw(app, app.token, request.id)).status).toBe(204);
  expect((await withdraw(app, app.token, request.id)).status).toBe(204);
  expect((await decide(app, request.id)).status).toBe(409);
  expect(await view(app, request.id)).toMatchObject({ state: 'withdrawn' });
  expect(
    (await auditRows(app)).filter((r) => r.outcome === 'approval_withdrawn'),
  ).toHaveLength(1);
});
it('E12: a request lists all paths but covers only those currently marked', async () => {
  await setMark(app);
  const request = await pending(app, app.token, randomUUID(), {
    secrets: [stripe, cloudflare],
  });
  expect(request.paths).toEqual([stripe]);
  expect(await view(app, request.id)).toMatchObject({
    verified: {
      secrets: expect.arrayContaining([
        { path: stripe, coveredBy: { kind: 'bucket', path: 'work' } },
        { path: cloudflare, coveredBy: null },
      ]),
    },
  });
});
it.each(['once', '1h', '12h'] as const)(
  'E13/E16: %s stores its precise D1 window; remembered reuse ignores every session claim',
  async (remember) => {
    await setMark(app);
    const first = await pending(app, app.token, randomUUID(), {
      agentSession: { agent: 'claude-code', session: 's1' },
    });
    expect((await decide(app, first.id, remember)).status).toBe(200);
    const row = (await requests(app))[0];
    expect(Number(row.valid_until) - Number(row.decided_at)).toBe(
      remember === 'once'
        ? 120_000
        : remember === '1h'
          ? 3_600_000
          : 43_200_000,
    );
    if (remember === 'once') return;
    expect(
      await (await fetch(`${app.origin}/api/approvals`)).json(),
    ).toMatchObject({
      pending: [],
      remembered: [{ id: first.id, state: 'approved', remember }],
    });
    const db = await app.mf.getD1Database('DB');
    await db
      .prepare(
        'UPDATE approval_requests SET decided_at=decided_at-1800000,valid_until=valid_until-1800000 WHERE id=?',
      )
      .bind(first.id)
      .run();
    for (const agentSession of [
      { agent: 'codex', session: 'c1' },
      { agent: 'declared', session: 'nightly' },
      undefined,
    ]) {
      const response = await ask(app, app.token, randomUUID(), {
        agentSession,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toHaveProperty('values');
    }
    expect(
      (await auditRows(app))
        .filter((r) => r.outcome === 'delivered')
        .every((r) => r.approval_id === first.id),
    ).toBe(true);
  },
);
it('E14: remembered approvals cover subsets but cannot widen the covered set', async () => {
  await setMark(app);
  await setMark(app, cloudflare, 'secret');
  const first = await pending(app, app.token, randomUUID(), {
    secrets: [stripe, database],
  });
  await decide(app, first.id, '1h');
  expect(
    await (
      await ask(app, app.token, randomUUID(), { secrets: [database] })
    ).json(),
  ).toHaveProperty('values');
  await pending(app, app.token, randomUUID(), {
    secrets: [stripe, cloudflare],
  });
});
it('E15: a remembered approval does not cover another machine or a closed window', async () => {
  await setMark(app);
  const first = await pending(app, app.token);
  await decide(app, first.id, '1h');
  await pending(app, (await issueGrant(app)).token);
  await age(app, first.id, 'valid_until', 3_600_001);
  await pending(app, app.token);
});
it('E17: narrowing a grant wins before approval logic and creates no request', async () => {
  await setMark(app);
  const first = await pending(app, app.token);
  await decide(app, first.id, '1h');
  const [machine] = await listMachines(app);
  expect(
    (
      await jsonRequest(
        app,
        `/api/machines/${machine.id}/grant`,
        { grant: ['me'], previous: 'all' },
        {},
        'PUT',
      )
    ).status,
  ).toBe(200);
  const response = await ask(app, app.token);
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ _tag: 'SecretsForbidden' });
  expect(await requests(app)).toHaveLength(1);
  expect((await auditRows(app)).some((r) => r.outcome === 'denied')).toBe(true);
});
it('E19: lost creation responses and concurrent duplicate attempts keep one request and one audit event', async () => {
  await setMark(app);
  const id = randomUUID();
  const [a, b] = await Promise.all([
    pending(app, app.token, id),
    pending(app, app.token, id),
  ]);
  expect(a.id).toBe(b.id);
  expect(a.url).toBe(b.url);
  expect((await pending(app, app.token, id)).id).toBe(a.id);
  expect(await requests(app)).toHaveLength(1);
  expect(
    (await auditRows(app)).filter((r) => r.outcome === 'approval_requested'),
  ).toHaveLength(1);
});
it('E20: the same once attempt can retry a lost delivery until two minutes after the decision', async () => {
  await setMark(app);
  const id = randomUUID();
  const first = await pending(app, app.token, id);
  await decide(app, first.id);
  for (let i = 0; i < 2; i++)
    expect(await (await ask(app, app.token, id)).json()).toHaveProperty(
      'values',
    );
  expect(
    (await auditRows(app)).filter((r) => r.outcome === 'delivered'),
  ).toHaveLength(2);
  await age(app, first.id, 'valid_until', 120_001);
  expect(await (await ask(app, app.token, id)).json()).toMatchObject({
    _tag: 'ApprovalExpired',
  });
});
it.each([
  { secrets: [database] },
  { purpose: 'different' },
  { workingDirectory: '/other' },
  { executable: 'other' },
  { agentSession: { agent: 'codex', session: 'c1' } },
])(
  'E21: changed attempt payload %j is InvalidRun without writes',
  async (changed) => {
    await setMark(app);
    const id = randomUUID();
    await pending(app, app.token, id);
    const before = await requests(app);
    const audit = await auditRows(app);
    expect(await (await ask(app, app.token, id, changed)).json()).toMatchObject(
      { _tag: 'InvalidRun' },
    );
    expect(await requests(app)).toEqual(before);
    expect(await auditRows(app)).toEqual(audit);
  },
);
it.each(['once', 'deny'] as const)(
  'E22: the first committed %s decision wins and repeating it is idempotent',
  async (firstChoice) => {
    await setMark(app);
    const first = await pending(app, app.token);
    expect((await decide(app, first.id, firstChoice)).status).toBe(200);
    expect((await decide(app, first.id, firstChoice)).status).toBe(200);
    const other = await decide(
      app,
      first.id,
      firstChoice === 'deny' ? 'once' : 'deny',
    );
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({
      _tag: 'AlreadyHandled',
      status: firstChoice === 'deny' ? 'denied' : 'approved',
      remember: firstChoice === 'deny' ? null : 'once',
    });
    expect(
      (await auditRows(app)).filter((r) =>
        ['approval_granted', 'approval_denied'].includes(String(r.outcome)),
      ),
    ).toHaveLength(1);
  },
);
it.each([['once', 120_000]] as const)(
  'E22: repeating %s after its validity window returns AlreadyHandled without another decision event',
  async (remember, window) => {
    await setMark(app);
    const first = await pending(app, app.token);
    expect((await decide(app, first.id, remember)).status).toBe(200);
    expect((await decide(app, first.id, remember)).status).toBe(200);
    await age(app, first.id, 'valid_until', window + 1);
    const before = await requests(app);
    const audit = await auditRows(app);
    const response = await decide(app, first.id, remember);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      _tag: 'AlreadyHandled',
      status: 'approved',
      remember,
    });
    expect(await requests(app)).toEqual(before);
    expect(await auditRows(app)).toEqual(audit);
  },
);
it.each(['once', 'deny'] as const)(
  'E9/E23: a late owner %s returns Expired and leaves the row undecided',
  async (choice) => {
    await setMark(app);
    const first = await pending(app, app.token);
    await age(app, first.id, 'expires_at', 600_001);
    expect((await decide(app, first.id, choice)).status).toBe(410);
    expect((await requests(app))[0].status).toBe('pending');
  },
);
it.each(['once', 'deny', 'withdraw'] as const)(
  'E24: a committed %s wins against a competing withdrawal or decision',
  async (firstChoice) => {
    await setMark(app);
    const first = await pending(app, app.token);
    if (firstChoice === 'withdraw') {
      await withdraw(app, app.token, first.id);
      expect((await decide(app, first.id, 'deny')).status).toBe(409);
    } else {
      await decide(app, first.id, firstChoice);
      await withdraw(app, app.token, first.id);
    }
    expect(await view(app, first.id)).toMatchObject({
      state:
        firstChoice === 'withdraw'
          ? 'withdrawn'
          : firstChoice === 'deny'
            ? 'denied'
            : 'approved',
    });
  },
);
it('E25: removing the last mark delivers and settles the waiting request as no longer needed', async () => {
  await setMark(app);
  const id = randomUUID();
  const first = await pending(app, app.token, id);
  expect((await mark(app, 'work', 'bucket', 'DELETE')).status).toBe(204);
  expect(await (await ask(app, app.token, id)).json()).toHaveProperty('values');
  expect(await view(app, first.id)).toMatchObject({ state: 'settled' });
});
it.each(['mark', 'grant'])(
  'E26: a %s committed between the read and delivery prevents every value and audit insert',
  async (change) => {
    let active = false;
    let batches = 0;
    const reached = deferred();
    const resume = deferred();
    const observed = await approvalFixture(async (label) => {
      if (active && label === '/before-batch' && ++batches === 2) {
        active = false;
        reached.resolve();
        await resume.promise;
      }
      return true;
    });
    try {
      active = true;
      const delivering = ask(observed, observed.token);
      await reached.promise;
      if (change === 'mark') await setMark(observed);
      else {
        const [m] = await listMachines(observed);
        await jsonRequest(
          observed,
          `/api/machines/${m.id}/grant`,
          { grant: ['me'], previous: 'all' },
          {},
          'PUT',
        );
      }
      resume.resolve();
      const response = await delivering;
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        _tag: 'ServiceUnavailable',
      });
      expect(
        (await auditRows(observed)).some((r) => r.outcome === 'delivered'),
      ).toBe(false);
      expect((await ask(observed, observed.token)).status).toBe(
        change === 'mark' ? 200 : 403,
      );
    } finally {
      resume.resolve();
      await observed.close();
    }
  },
);
it.each(['once', '1h'] as const)(
  'E27: simultaneous requests settle the other only for a remembered %s approval',
  async (remember) => {
    await setMark(app);
    const ids = [randomUUID(), randomUUID()];
    const first = await pending(app, app.token, ids[0]);
    const second = await pending(app, app.token, ids[1]);
    expect(first.id).not.toBe(second.id);
    await decide(app, first.id, remember);
    expect(await (await ask(app, app.token, ids[1])).json()).toHaveProperty(
      remember === 'once' ? 'approval' : 'values',
    );
    expect(await view(app, second.id)).toMatchObject({
      state: remember === 'once' ? 'pending' : 'settled',
    });
  },
);
it('E28: pending limits are five per machine and fifty globally; expiry and lazy cleanup free capacity', async () => {
  await setMark(app);
  for (let i = 0; i < 5; i++) await pending(app, app.token);
  expect((await ask(app, app.token)).status).toBe(429);
  const db = await app.mf.getD1Database('DB');
  await db
    .prepare('UPDATE approval_requests SET expires_at=expires_at-600001')
    .run();
  await pending(app, app.token);
  const first = (await requests(app))[0];
  await db
    .prepare(
      'UPDATE approval_requests SET expires_at=expires_at-86400001 WHERE id=?',
    )
    .bind(first.id)
    .run();
  for (let machine = 0; machine < 10; machine++) {
    const other = await issueGrant(app);
    for (let i = 0; i < (machine === 9 ? 4 : 5); i++)
      await pending(app, other.token);
  }
  const extra = await issueGrant(app);
  expect((await ask(app, extra.token)).status).toBe(429);
  expect((await requests(app)).some((r) => r.id === first.id)).toBe(false);
});
it('E29: a released v0.3.2 payload is refused for covered secrets but unmarked delivery stays compatible', async () => {
  await setMark(app);
  const response = await fetchValues(app, app.token, { secrets: [stripe] });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    _tag: 'VaultNotConfigured',
    message: `${stripe} needs the owner's approval, and this nook version cannot ask. Update nook.`,
  });
  expect((await auditRows(app))[0]).toMatchObject({
    outcome: 'approval_refused',
    path: stripe,
  });
  expect(
    await (await fetchValues(app, app.token, { secrets: [cloudflare] })).json(),
  ).toHaveProperty('values');
});
it('E30: owner APIs, storage, errors, audit and Worker logs contain no secret value', async () => {
  const logs: string[] = [];
  await app.setBindings(app.bindings, {
    handleRuntimeStdio: (out, err) => {
      out.on('data', (d) => logs.push(String(d)));
      err.on('data', (d) => logs.push(String(d)));
    },
  });
  await setMark(app);
  const id = randomUUID();
  const first = await pending(app, app.token, id, { secrets: [acmePath] });
  const all: unknown[] = [
    first,
    await view(app, first.id),
    await (await fetch(`${app.origin}/api/approvals`)).json(),
  ];
  await decide(app, first.id, 'deny');
  all.push(
    await (await ask(app, app.token, id, { secrets: [acmePath] })).json(),
    await requests(app),
    await auditRows(app),
    await auditPageData(app),
    logs,
  );
  expectNoValue(JSON.stringify(all), [app.input.value]);
});
