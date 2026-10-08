import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Log, LogLevel } from 'miniflare';
import { beforeEach, expect, it } from 'vitest';
import { access, accessFixture } from './support/access.ts';
import {
  acmePath,
  auditPageData,
  auditRows,
  fetchValues,
  runFixture,
  runInput,
} from './support/audit.ts';
import { issueGrant, machineMcp } from './support/grants.ts';
import { deferred, listMachines, revokeMachine } from './support/machines.ts';
import {
  createSecret,
  deleteSecret,
  expectNoValue,
  keyFingerprint,
  listSecrets,
  secretInput,
} from './support/vault.ts';
import { vaultCheckpoints } from './support/vault-checkpoints.ts';

let app: Awaited<ReturnType<typeof runFixture>>;
beforeEach(async () => {
  app = await runFixture();
  return () => app.close();
});
it('E10/E28: distinct values are delivered only after a complete private audit, with no-store', async () => {
  const other = secretInput({ name: 'OTHER_KEY' });
  expect((await createSecret(app, other)).status).toBe(201);
  const started = Date.now();
  const response = await fetchValues(app, app.token, {
    secrets: [acmePath, 'work/acme/OTHER_KEY', acmePath],
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const body = (await response.json()) as {
    values: { path: string; value: string }[];
  };
  expect(body.values.map((entry) => entry.path)).toEqual([
    acmePath,
    'work/acme/OTHER_KEY',
  ]);
  expect(body.values[0].value === app.input.value).toBe(true);
  expect(body.values[1].value === other.value).toBe(true);
  const page = await auditPageData(app);
  expect(page.entries).toHaveLength(2);
  expect(new Set(page.entries.map((entry) => entry.runId)).size).toBe(1);
  for (const entry of page.entries) {
    expect(entry).toMatchObject({
      outcome: 'delivered',
      purpose: runInput().purpose,
      machine: { id: app.machine.id, name: 'work-laptop' },
      workingDirectory: runInput().workingDirectory,
      executable: 'gh',
    });
    expect(new Date(entry.at).toISOString()).toBe(entry.at);
    expect(
      Date.parse(entry.at) >= started && Date.parse(entry.at) <= Date.now(),
    ).toBe(true);
  }
  expectNoValue(JSON.stringify({ page, rows: await auditRows(app) }), [
    app.input.value,
    other.value,
    app.token,
    app.key,
  ]);
});
it.each(
  [
    ['personal/finances/PLAID_SECRET'],
    [acmePath, 'personal/finances/PLAID_SECRET'],
    ['personal/missing/ABSENT'],
    ['work/acme-old/GH_TOKEN'],
  ].map((secrets) => ({ secrets })),
)(
  'E7/E12: deny before reading or checking existence (%#)',
  async ({ secrets }) => {
    const response = await fetchValues(app, app.token, { secrets });
    expect(response.status).toBe(403);
    const denied = secrets.filter((path) => path !== acmePath);
    expect(await response.json()).toEqual({
      _tag: 'SecretsForbidden',
      paths: denied,
    });
    const entries = (await auditPageData(app)).entries;
    expect(entries.map((entry) => entry.path).sort()).toEqual(
      [...denied].sort(),
    );
    expect(entries.every((entry) => entry.outcome === 'denied')).toBe(true);
  },
);
it.each([false, true])(
  'E8: an allowed missing path fails the entire request without audit (mixed: %s)',
  async (mixed) => {
    const response = await fetchValues(app, app.token, {
      secrets: [...(mixed ? [acmePath] : []), 'work/acme/MISSING'],
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      _tag: 'SecretNotFound',
      message: 'work/acme/MISSING was not found.',
    });
    expect(await auditRows(app)).toEqual([]);
  },
);
it.each(['mismatch', 'missing', 'corrupt'])(
  'E8: %s encryption key/envelope produces private fixed failure and no audit',
  async (kind) => {
    if (kind === 'corrupt')
      await (await app.mf.getD1Database('DB'))
        .prepare(
          "UPDATE secrets SET ciphertext=replace(ciphertext, substr(ciphertext,1,1), 'z')",
        )
        .run();
    else
      await app.setBindings({
        ...app.bindings,
        VAULT_KEY: kind === 'missing' ? '' : randomBytes(32).toString('base64'),
      });
    const response = await fetchValues(app, app.token);
    expect(response.status).toBe(503);
    const text = await response.text();
    expectNoValue(text, [app.input.value, app.token, app.key]);
    expect(JSON.parse(text)).toEqual(
      kind === 'missing'
        ? {
            _tag: 'VaultNotConfigured',
            message:
              'This installation has no VAULT_KEY. Add it as a Worker secret, then try again.',
          }
        : {
            _tag: 'SecretKeyUnavailable',
            message: `Cannot open a secret encrypted with key ${keyFingerprint(app.key)}.`,
          },
    );
    expect(await auditRows(app)).toEqual([]);
  },
);
it('E11/E12: one auth statement, one read batch, one audit batch; commit precedes response and lost responses are independent uses', async () => {
  const labels: string[] = [];
  let mode = 'normal';
  let batches = 0;
  const reached = deferred();
  const release = deferred();
  const measured = await vaultCheckpoints(async (label) => {
    labels.push(label);
    if (label === '/before-batch') {
      batches++;
      if (mode === 'fail-audit' && batches === 2) return false;
    }
    if (label === '/after-batch' && batches === 2) {
      if (mode === 'hold') {
        reached.resolve();
        await release.promise;
      }
      if (mode === 'lose') return false;
    }
    return true;
  });
  try {
    expect(
      (await createSecret(measured, secretInput({ name: 'GH_TOKEN' }))).status,
    ).toBe(201);
    const { token } = await issueGrant(measured, ['work/acme']);
    labels.length = 0;
    batches = 0;
    mode = 'hold';
    let answered = false;
    const pending = fetchValues(measured, token).then((response) => {
      answered = true;
      return response;
    });
    const early = await Promise.race([
      reached.promise.then(() => null),
      pending,
    ]);
    if (early)
      expect(early.status, 'The endpoint must reach the audit checkpoint').toBe(
        200,
      );
    expect(answered).toBe(false);
    expect(await auditRows(measured)).toHaveLength(1);
    release.resolve();
    expect((await pending).status).toBe(200);
    expect(labels).toEqual([
      '/statement',
      '/before-batch',
      '/after-batch',
      '/before-batch',
      '/after-batch',
    ]);
    labels.length = 0;
    batches = 0;
    mode = 'fail-audit';
    const failed = await fetchValues(measured, token);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ _tag: 'ServiceUnavailable' });
    expect(await auditRows(measured)).toHaveLength(1);
    batches = 0;
    mode = 'lose';
    expect((await fetchValues(measured, token)).status).toBe(503);
    batches = 0;
    mode = 'normal';
    expect((await fetchValues(measured, token)).status).toBe(200);
    const threeRuns = await auditRows(measured);
    expect(threeRuns).toHaveLength(3);
    expect(new Set(threeRuns.map((row) => row.run_id)).size).toBe(3);
    labels.length = 0;
    batches = 0;
    expect(
      (
        await fetchValues(measured, token, {
          secrets: [acmePath, 'personal/missing/ABSENT'],
        })
      ).status,
    ).toBe(403);
    expect(labels).toEqual(['/statement', '/before-batch', '/after-batch']);
    labels.length = 0;
    await auditPageData(measured);
    expect(labels).toEqual(['/statement']);
  } finally {
    release.resolve();
    await measured.close();
  }
});
it.each([
  { purpose: '' },
  { purpose: '  ' },
  { purpose: 'bad\nline' },
  { purpose: 'bad\rline' },
  { purpose: 'bad\u2028line' },
  { purpose: 'bad\u2029line' },
  { purpose: '🔐'.repeat(201) },
  { workingDirectory: '' },
  { workingDirectory: 'relative' },
  { workingDirectory: '/' + '界'.repeat(1366) },
  { workingDirectory: '/bad\0dir' },
  { executable: '' },
  { executable: 'node/path' },
  { executable: 'x'.repeat(256) },
  { executable: '界'.repeat(86) },
  { executable: 'bad\0name' },
  { secrets: [] },
  { secrets: Array.from({ length: 21 }, (_, i) => `work/acme/KEY_${i}`) },
  { secrets: ['Work/Acme/GH_TOKEN'] },
  { secrets: ['work/acme'] },
  { purpose: { private: 'synthetic-invalid-request' } },
])(
  'E14: invalid bounds neither read secrets nor audit (%#)',
  async (overrides) => {
    const labels: string[] = [];
    const measured = await vaultCheckpoints(async (label) => {
      labels.push(label);
      return true;
    });
    try {
      const { token } = await issueGrant(measured);
      labels.length = 0;
      const response = await fetchValues(measured, token, overrides);
      expect(response.status).toBe(400);
      expect(labels.filter((label) => label !== '/statement')).toEqual([]);
      expect(await auditRows(measured)).toEqual([]);
      expectNoValue(await response.text(), [app.input.value]);
    } finally {
      await measured.close();
    }
  },
);
it('E14: code-point purpose, byte bounds and twenty distinct paths accept their boundaries', async () => {
  for (let i = 0; i < 20; i++)
    expect(
      (await createSecret(app, secretInput({ name: `BOUND_${i}` }))).status,
    ).toBe(201);
  const response = await fetchValues(app, app.token, {
    purpose: '🔐'.repeat(200),
    workingDirectory: '/' + 'x'.repeat(4095),
    executable: 'x'.repeat(255),
    secrets: Array.from({ length: 20 }, (_, i) => `work/acme/BOUND_${i}`),
  });
  expect(response.status).toBe(200);
  expect(await auditRows(app)).toHaveLength(20);
});
it('E13: machine values require Bearer, owner audit requires Access, foreign Origin is denied', async () => {
  const issuer = await accessFixture();
  await app.setBindings(
    { ...access, VAULT_KEY: app.key },
    { outboundService: issuer.outboundService },
  );
  const owner = { 'Cf-Access-Jwt-Assertion': await issuer.assertion() };
  for (const headers of [{}, owner])
    expect((await fetchValues(app, undefined, {}, headers)).status).toBe(401);
  expect(
    (
      await fetch(`${app.origin}/api/audit`, {
        headers: { Authorization: `Bearer ${app.token}` },
      })
    ).status,
  ).toBe(401);
  expect(
    (await fetchValues(app, app.token, {}, { Origin: 'https://foreign.test' }))
      .status,
  ).toBe(403);
  expect(
    (await fetch(`${app.origin}/api/audit`, { headers: owner })).status,
  ).toBe(200);
  expect(
    (
      await fetch(`${app.origin}/api/audit`, {
        headers: {
          'Cf-Access-Jwt-Assertion': await issuer.assertion({
            email: 'other@nook.test',
          }),
        },
      })
    ).status,
  ).toBe(403);
  expect(await auditRows(app)).toEqual([]);
});
it('E13/E15: stable newest-first keyset pages and historical filters survive deletion and revocation', async () => {
  for (let index = 0; index < 56; index++)
    expect((await fetchValues(app, app.token)).status).toBe(200);
  const db = await app.mf.getD1Database('DB');
  await db
    .prepare("UPDATE audit_entries SET at='2026-10-08T10:00:00.000Z'")
    .run();
  const first = await auditPageData(app);
  expect(first.entries).toHaveLength(25);
  expect(first.next).toBeTruthy();
  const sorted = [...first.entries.map((entry) => entry.id)].sort().reverse();
  expect(first.entries.map((entry) => entry.id)).toEqual(sorted);
  expect((await fetchValues(app, app.token)).status).toBe(200);
  const second = await auditPageData(
    app,
    `?cursor=${encodeURIComponent(first.next!)}`,
  );
  const last = await auditPageData(
    app,
    `?cursor=${encodeURIComponent(second.next!)}`,
  );
  expect(second.entries).toHaveLength(25);
  expect(last.entries).toHaveLength(6);
  expect(last.next).toBeNull();
  expect(
    new Set(
      [...first.entries, ...second.entries, ...last.entries].map(
        (entry) => entry.id,
      ),
    ).size,
  ).toBe(56);
  const [secret] = await listSecrets(app);
  expect((await deleteSecret(app, acmePath, secret.version)).status).toBe(204);
  expect((await revokeMachine(app, app.machine.id)).status).toBe(204);
  for (const query of [
    '?bucket=work',
    '?bucket=work%2Facme',
    '?secret=work%2Facme%2FGH_TOKEN',
  ]) {
    const entries = (await auditPageData(app, query)).entries;
    expect(entries).toHaveLength(25);
    expect(entries.every((entry) => entry.machine.name === 'work-laptop')).toBe(
      true,
    );
  }
  expect((await auditPageData(app, '?bucket=work%2Facme-old')).entries).toEqual(
    [],
  );
  expect(
    (await auditPageData(app, '?secret=work%2Facme%2FMISSING')).entries,
  ).toEqual([]);
});
it.each([
  '?bucket=Work',
  '?secret=work/acme',
  '?cursor=garbage',
  '?cursor=e30',
  '?cursor=%21',
  `?cursor=${'a'.repeat(257)}`,
  `?cursor=${Buffer.from(JSON.stringify({ at: 'invalid-time', id: '12345678-1234-4123-8123-123456789abc' })).toString('base64url')}`,
  `?cursor=${Buffer.from(JSON.stringify({ at: '2026-10-08T12:00:00.000Z', id: 'invalid-id' })).toString('base64url')}`,
  '?bucket=/work',
  '?secret=work/acme/GH_TOKEN/extra',
])('E13: malformed audit filters/cursors return 400 (%s)', async (query) => {
  expect((await fetch(`${app.origin}/api/audit${query}`)).status).toBe(400);
});
it('E13: a restricted principal cannot list owner audit entries', async () => {
  const labels: string[] = [];
  const restricted = await vaultCheckpoints(
    async (label) => {
      labels.push(label);
      return true;
    },
    ['work/acme'],
  );
  try {
    expect(
      (
        await fetch(
          `${restricted.origin}/api/audit?secret=personal/finances/PLAID_SECRET`,
        )
      ).status,
    ).toBe(403);
    expect(labels).toEqual([]);
  } finally {
    await restricted.close();
  }
});
it('E16/E28: MCP discovery directs agents to nook run and exposes no values', async () => {
  const driver = machineMcp(app, app.token);
  const tools = await driver.listTools();
  const description =
    tools.tools.find((tool) => tool.name === 'list_secrets')?.description ?? '';
  expect(description).toContain(
    'nook run --secret ENV=bucket/NAME --purpose "…" -- <command>',
  );
  expect(description).toMatch(/never values/);
  expect(description).toMatch(/instead of asking the owner/);
  // Issue #6, E15: the remote description is enough to use project mappings.
  expect(description).toMatch(/project.*nook\.json/i);
  expect(description).toMatch(/mapped secrets.*injected without --secret/i);
  expectNoValue(
    JSON.stringify({
      tools,
      result: await driver.call('list_secrets', { bucket: 'work/acme' }),
    }),
    [app.input.value, app.token, app.key],
  );
});

class PrivateRunLog extends Log {
  messages: string[] = [];
  constructor() {
    super(LogLevel.VERBOSE);
  }
  protected log(message: string) {
    this.messages.push(message);
  }
}
it('E11/E28: genuine audit write failure rolls back every row and exposes no private diagnostics', async () => {
  const log = new PrivateRunLog();
  await app.setBindings(app.bindings, {
    log,
    handleRuntimeStdio: (stdout, stderr) => {
      for (const input of [stdout, stderr])
        createInterface({ input }).on('line', (line) =>
          log.messages.push(line),
        );
    },
  });
  const other = secretInput({ name: 'OTHER_KEY' });
  expect((await createSecret(app, other)).status).toBe(201);
  await (await app.mf.getD1Database('DB'))
    .prepare(
      `CREATE TRIGGER audit_failure BEFORE INSERT ON audit_entries WHEN NEW.path='work/acme/OTHER_KEY' BEGIN SELECT RAISE(ABORT, '${app.input.value}'); END`,
    )
    .run();
  const response = await fetchValues(app, app.token, {
    secrets: [acmePath, 'work/acme/OTHER_KEY'],
  });
  expect(response.status).toBe(503);
  const text = await response.text();
  expectNoValue(text, [app.input.value, other.value, app.token, app.key]);
  expect(JSON.parse(text)).toEqual({ _tag: 'ServiceUnavailable' });
  expect(await auditRows(app)).toEqual([]);
  expectNoValue(log.messages.join('\n'), [
    app.input.value,
    other.value,
    app.token,
    app.key,
  ]);
});

it('E8: an undecryptable later path fails the whole fetch without partial delivery or audit', async () => {
  const other = secretInput({ name: 'OTHER_KEY' });
  expect((await createSecret(app, other)).status).toBe(201);
  await (await app.mf.getD1Database('DB'))
    .prepare(
      "UPDATE secrets SET key_id='0000000000000000' WHERE name='OTHER_KEY'",
    )
    .run();
  const response = await fetchValues(app, app.token, {
    secrets: [acmePath, 'work/acme/OTHER_KEY'],
  });
  expect(response.status).toBe(503);
  const text = await response.text();
  expectNoValue(text, [app.input.value, other.value, app.key, app.token]);
  expect(JSON.parse(text)).toEqual({
    _tag: 'SecretKeyUnavailable',
    message: 'Cannot open a secret encrypted with key 0000000000000000.',
  });
  expect(await auditRows(app)).toEqual([]);
});

it('E14: the first directory byte beyond the limit is rejected before reads and audit', async () => {
  const labels: string[] = [];
  const measured = await vaultCheckpoints(async (label) => {
    labels.push(label);
    return true;
  });
  try {
    const { token } = await issueGrant(measured);
    labels.length = 0;
    const response = await fetchValues(measured, token, {
      workingDirectory: '/' + 'x'.repeat(4096),
    });
    expect(response.status).toBe(400);
    expect(labels).toEqual(['/statement']);
    expect(await auditRows(measured)).toEqual([]);
  } finally {
    await measured.close();
  }
});
it.each([
  { extra: true },
  { at: '2026-10-08T12:00:00Z' },
  { at: 1791460800000 },
])(
  'E13: a cursor must use the exact opaque encoding issued by the API (%#)',
  async (invalid) => {
    const cursor = Buffer.from(
      JSON.stringify({
        at: '2026-10-08T12:00:00.000Z',
        id: '12345678-1234-4123-8123-123456789abc',
        ...invalid,
      }),
    ).toString('base64url');
    expect(
      (await fetch(`${app.origin}/api/audit?cursor=${cursor}`)).status,
    ).toBe(400);
  },
);
it('E28: a genuine secret read failure exposes only a fixed unavailable response', async () => {
  const log = new PrivateRunLog();
  await app.setBindings(app.bindings, {
    log,
    handleRuntimeStdio: (stdout, stderr) => {
      for (const input of [stdout, stderr])
        createInterface({ input }).on('line', (line) =>
          log.messages.push(line),
        );
    },
  });
  await (await app.mf.getD1Database('DB'))
    .prepare('ALTER TABLE secrets RENAME TO unavailable_secrets')
    .run();
  const response = await fetchValues(app, app.token);
  expect(response.status).toBe(503);
  const text = await response.text();
  expectNoValue(text + log.messages.join('\n'), [
    app.input.value,
    app.token,
    app.key,
  ]);
  expect(JSON.parse(text)).toEqual({ _tag: 'ServiceUnavailable' });
  expect(await auditRows(app)).toEqual([]);
});

it('E13: chronology and subtree filters distinguish newer prefix lookalikes', async () => {
  expect((await fetchValues(app, app.token)).status).toBe(200);
  expect(
    (await fetchValues(app, app.token, { secrets: ['work/acme-old/GH_TOKEN'] }))
      .status,
  ).toBe(403);
  const db = await app.mf.getD1Database('DB');
  await db
    .prepare(
      "UPDATE audit_entries SET at=CASE WHEN path='work/acme/GH_TOKEN' THEN '2026-10-07T12:00:00.000Z' ELSE '2026-10-08T12:00:00.000Z' END",
    )
    .run();
  const all = await auditPageData(app);
  expect(all.entries.map((entry) => entry.path)).toEqual([
    'work/acme-old/GH_TOKEN',
    acmePath,
  ]);
  const subtree = await auditPageData(app, '?bucket=work%2Facme');
  expect(subtree.entries.map((entry) => entry.path)).toEqual([acmePath]);
});
it('E13: a final full-sized audit page has no next cursor', async () => {
  for (let index = 0; index < 25; index++) {
    const response = await fetchValues(app, app.token);
    expect(response.status).toBe(200);
    await response.body?.cancel();
  }
  const page = await auditPageData(app);
  expect(page.entries).toHaveLength(25);
  expect(page.next).toBeNull();
});
it('E13/E14: public typed validation failures preserve their safe contract payload', async () => {
  const run = await fetchValues(app, app.token, { purpose: '' });
  expect(run.status).toBe(400);
  const invalid = (await run.json()) as { _tag: string; message?: string };
  expectNoValue(JSON.stringify(invalid), [app.input.value, app.token, app.key]);
  expect(invalid._tag).toBe('InvalidRun');
  expect(
    typeof invalid.message === 'string' && /purpose/i.test(invalid.message),
  ).toBe(true);
  const audit = await fetch(`${app.origin}/api/audit?bucket=Work`);
  expect(audit.status).toBe(400);
  expect(await audit.json()).toEqual({ _tag: 'InvalidAuditFilter' });
  expect(await auditRows(app)).toEqual([]);
});
