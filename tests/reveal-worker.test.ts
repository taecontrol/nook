import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { Effect } from 'effect';
import { Log, LogLevel } from 'miniflare';
import { beforeEach, expect, expectTypeOf, it } from 'vitest';
import { unstable_splitSqlQuery } from 'wrangler';
import type { machineVault } from '../apps/worker/src/vault.ts';
import { applyMigrations } from '../scripts/lib/migrations.ts';
import { access, accessFixture } from './support/access.ts';
import { auditPageData, auditRows } from './support/audit.ts';
import { issueGrant, machineMcp } from './support/grants.ts';
import { deferred } from './support/machines.ts';
import { mcpDriver } from './support/mcp.ts';
import {
  revealCountry,
  revealIp,
  revealPath,
  revealSecret,
  revealValue,
  setRevealValue,
} from './support/reveal.ts';
import {
  createSecret,
  deleteSecret,
  expectNoValue,
  keyFingerprint,
  listSecrets,
  secretInput,
  vaultRuntime,
} from './support/vault.ts';
import { vaultCheckpoints } from './support/vault-checkpoints.ts';

let app: Awaited<ReturnType<typeof vaultRuntime>>;
beforeEach(async () => {
  app = await vaultRuntime();
  await app.setBindings(app.bindings, { cf: { country: revealCountry } });
  await setRevealValue(app, revealValue);
  return () => app.close();
});
async function privateFailure(response: Response, tag: string, status: number) {
  expect(response.status).toBe(status);
  const text = await response.text();
  expectNoValue(text, [revealValue, app.key]);
  expect(JSON.parse(text)._tag).toBe(tag);
  expect(await auditRows(app)).toEqual([]);
  return JSON.parse(text) as { _tag: string; message?: string };
}
it('E4/E14/E20: the real HTTP request records its IP/country, one reveal, and no machine facts before no-store delivery', async () => {
  const measured = await vaultCheckpoints(async () => true, undefined, false, {
    observeStatements: true,
  });
  try {
    await measured.setBindings(measured.bindings, {
      cf: { country: revealCountry },
    });
    const headers = { 'CF-Connecting-IP': revealIp };
    expect(
      await (
        await fetch(`${measured.origin}/api/__test/request-facts`, { headers })
      ).json(),
    ).toEqual({ ip: revealIp, country: revealCountry });
    await setRevealValue(measured, revealValue);
    const started = Date.now();
    const response = await revealSecret(measured, revealPath, headers);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(
      ((await response.json()) as { value: string }).value === revealValue,
    ).toBe(true);
    const rows = await auditRows(measured);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: 'revealed',
      path: revealPath,
      purpose: 'Revealed in web app',
      ip: revealIp,
      country: revealCountry,
      machine_id: null,
      machine_name: null,
      working_directory: null,
      executable: null,
      run_id: null,
    });
    expect(
      Date.parse(String(rows[0].at)) >= started &&
        Date.parse(String(rows[0].at)) <= Date.now(),
    ).toBe(true);
    const [entry] = (await auditPageData(measured)).entries;
    expect(entry).toEqual({
      id: rows[0].id,
      at: rows[0].at,
      outcome: 'revealed',
      path: revealPath,
      bucket: 'work/acme',
      name: 'STRIPE_KEY',
      purpose: 'Revealed in web app',
      ip: revealIp,
      country: revealCountry,
    });
    expectNoValue(JSON.stringify(rows), [revealValue, measured.key]);
  } finally {
    await measured.close();
  }
});
it('E2: reveal preserves all 64 KiB of UTF-8, spaces and trailing newline', async () => {
  const value =
    '  秘密🔐\n' +
    'x'.repeat(65536 - Buffer.byteLength('  秘密🔐\n  \n')) +
    '  \n';
  await setRevealValue(app, value);
  const response = await revealSecret(app);
  expect(response.status).toBe(200);
  expect(((await response.json()) as { value: string }).value === value).toBe(
    true,
  );
});
it('E9: deletion after metadata load returns the safe not-found error and no entry', async () => {
  const [secret] = await listSecrets(app);
  expect((await deleteSecret(app, revealPath, secret.version)).status).toBe(
    204,
  );
  expect(
    await privateFailure(await revealSecret(app), 'SecretNotFound', 404),
  ).toEqual({ _tag: 'SecretNotFound', message: 'Secret not found.' });
});
it.each(['missing', 'mismatch', 'corrupt'])(
  'E10/E19: %s key/envelope fails without value or audit',
  async (kind) => {
    if (kind === 'corrupt')
      await (await app.mf.getD1Database('DB'))
        .prepare("UPDATE secrets SET key_id='0000000000000000'")
        .run();
    else
      await app.setBindings({
        ...app.bindings,
        VAULT_KEY: kind === 'missing' ? '' : randomBytes(32).toString('base64'),
      });
    expect(
      await privateFailure(
        await revealSecret(app),
        kind === 'missing' ? 'VaultNotConfigured' : 'SecretKeyUnavailable',
        503,
      ),
    ).toEqual(
      kind === 'missing'
        ? {
            _tag: 'VaultNotConfigured',
            message:
              'This installation has no VAULT_KEY. Add it as a Worker secret, then try again.',
          }
        : {
            _tag: 'SecretKeyUnavailable',
            message: `Cannot open a secret encrypted with key ${kind === 'corrupt' ? '0000000000000000' : keyFingerprint(app.key)}.`,
          },
    );
  },
);
class PrivateRevealLog extends Log {
  messages: string[] = [];
  constructor() {
    super(LogLevel.VERBOSE);
  }
  protected log(message: string) {
    this.messages.push(message);
  }
}
it.each(['read', 'audit'])(
  'E11/E12/E19: genuine D1 %s failure returns only a fixed 503, with private logs and no audit',
  async (kind) => {
    const log = new PrivateRevealLog();
    await app.setBindings(app.bindings, {
      log,
      handleRuntimeStdio: (stdout, stderr) => {
        for (const input of [stdout, stderr])
          createInterface({ input }).on('line', (line) =>
            log.messages.push(line),
          );
      },
    });
    const db = await app.mf.getD1Database('DB');
    if (kind === 'read')
      await db
        .prepare('ALTER TABLE secrets RENAME TO unavailable_secrets')
        .run();
    else
      await db
        .prepare(
          `CREATE TRIGGER reveal_failure BEFORE INSERT ON audit_entries BEGIN SELECT RAISE(ABORT, '${revealValue}'); END`,
        )
        .run();
    expect(
      await privateFailure(await revealSecret(app), 'ServiceUnavailable', 503),
    ).toEqual({ _tag: 'ServiceUnavailable' });
    expectNoValue(log.messages.join('\n'), [revealValue, app.key]);
  },
);
it('E13/budget: one read and one insert, audit commits before response, failed writes deliver nothing, and lost-response retries add another entry', async () => {
  let mode = 'normal';
  let statements = 0;
  const labels: string[] = [];
  const reached = deferred();
  const release = deferred();
  const measured = await vaultCheckpoints(
    async (label) => {
      labels.push(label);
      if (label === '/statement') {
        statements++;
        if (mode === 'fail-audit' && statements === 2) return false;
      }
      if (label === '/after-statement' && statements === 2) {
        if (mode === 'hold') {
          reached.resolve();
          await release.promise;
        }
        if (mode === 'lose') return false;
      }
      return true;
    },
    undefined,
    false,
    { observeStatements: true },
  );
  try {
    await setRevealValue(measured, revealValue);
    labels.length = 0;
    statements = 0;
    mode = 'hold';
    let answered = false;
    const pending = revealSecret(measured).then((response) => {
      answered = true;
      return response;
    });
    const early = await Promise.race([
      reached.promise.then(() => null),
      pending,
    ]);
    expect(
      early,
      'Reveal must reach the committed audit checkpoint',
    ).toBeNull();
    expect(answered).toBe(false);
    expect(await auditRows(measured)).toHaveLength(1);
    release.resolve();
    expect((await pending).status).toBe(200);
    expect(labels).toEqual([
      '/statement',
      '/after-statement',
      '/statement',
      '/after-statement',
    ]);
    statements = 0;
    mode = 'fail-audit';
    const failed = await revealSecret(measured);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ _tag: 'ServiceUnavailable' });
    expect(await auditRows(measured)).toHaveLength(1);
    statements = 0;
    mode = 'lose';
    const lost = await revealSecret(measured);
    expect(lost.status).toBe(503);
    expect(await lost.json()).toEqual({ _tag: 'ServiceUnavailable' });
    expect(await auditRows(measured)).toHaveLength(2);
    statements = 0;
    mode = 'normal';
    expect((await revealSecret(measured)).status).toBe(200);
    const rows = await auditRows(measured);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
  } finally {
    release.resolve();
    await measured.close();
  }
});
it('E14/E15/E18/E19: Access owner succeeds; missing assertion, other email, Nook Bearer, foreign Origin and GET cannot reveal', async () => {
  const { token } = await issueGrant(app);
  const issuer = await accessFixture();
  await app.setBindings(
    { ...access, VAULT_KEY: app.key },
    { outboundService: issuer.outboundService },
  );
  const owner = { 'Cf-Access-Jwt-Assertion': await issuer.assertion() };
  for (const [headers, status] of [
    [{}, 401],
    [{ Authorization: `Bearer ${token}` }, 401],
    [
      {
        'Cf-Access-Jwt-Assertion': await issuer.assertion({
          email: 'other@nook.test',
        }),
      },
      403,
    ],
    [{ ...owner, Origin: 'https://foreign.test' }, 403],
  ] as const) {
    const response = await revealSecret(app, revealPath, headers);
    expect(response.status).toBe(status);
    expectNoValue(await response.text(), [revealValue, token, app.key]);
    expect(await auditRows(app)).toEqual([]);
  }
  const get = await fetch(
    `${app.origin}/api/secrets/${encodeURIComponent(revealPath)}/reveal`,
    { headers: owner },
  );
  expect([404, 405]).toContain(get.status);
  expectNoValue(await get.text(), [revealValue]);
  expect(await auditRows(app)).toEqual([]);
  expect((await revealSecret(app, revealPath, owner)).status).toBe(200);
  expect(await auditRows(app)).toHaveLength(1);
});
it('E16/E23: machines have no reveal route/capability and MCP keeps the same names-only tools', async () => {
  type MachineFace = Effect.Success<ReturnType<typeof machineVault>>;
  expectTypeOf<
    Extract<keyof MachineFace, 'reveal' | 'values'>
  >().toEqualTypeOf<never>();
  const { token } = await issueGrant(app);
  const response = await fetch(
    `${app.origin}/api/machine/secrets/${encodeURIComponent(revealPath)}/reveal`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
  );
  expect([404, 405]).toContain(response.status);
  expectNoValue(await response.text(), [revealValue, token]);
  for (const driver of [machineMcp(app, token), mcpDriver(app.origin)]) {
    const tools = await driver.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'create_bucket',
      'delete_bucket',
      'list_buckets',
      'list_secrets',
    ]);
    const result = await driver.call('list_secrets', { bucket: 'work/acme' });
    expectNoValue(JSON.stringify({ tools, result }), [
      revealValue,
      app.key,
      token,
    ]);
    const attempted = await driver.request('tools/call', {
      name: 'reveal_secret',
      arguments: { path: revealPath },
    });
    const unavailableTool = await attempted.text();
    expect(unavailableTool).toMatch(/error|not found/i);
    expectNoValue(unavailableTool, [revealValue]);
  }
  expect(await auditRows(app)).toEqual([]);
});
it('E17: subtree denial precedes every statement and audit; an in-grant reveal succeeds', async () => {
  const labels: string[] = [];
  const measured = await vaultCheckpoints(
    async (label) => {
      labels.push(label);
      return true;
    },
    ['work/acme'],
    false,
    { observeStatements: true },
  );
  try {
    expect(
      (await createSecret(measured, secretInput({ value: revealValue })))
        .status,
    ).toBe(201);
    for (const path of [
      'personal/finances/PLAID_SECRET',
      'personal/missing/ABSENT',
      'work/acme-old/STRIPE_KEY',
    ]) {
      labels.length = 0;
      const response = await revealSecret(measured, path);
      expect(response.status).toBe(403);
      expectNoValue(await response.text(), [revealValue, measured.key]);
      expect(labels).toEqual([]);
      expect(await auditRows(measured)).toEqual([]);
    }
    expect((await revealSecret(measured)).status).toBe(200);
    expect(await auditRows(measured)).toHaveLength(1);
  } finally {
    await measured.close();
  }
});
it('State space: concurrent reveals have distinct entries; replacement after read returns the read value and retry returns the new value', async () => {
  const responses = await Promise.all([revealSecret(app), revealSecret(app)]);
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  expect(await auditRows(app)).toHaveLength(2);
  let statements = 0;
  let replace = false;
  const measured = await vaultCheckpoints(
    async (label) => {
      if (label === '/statement') statements++;
      if (replace && label === '/after-statement' && statements === 1) {
        replace = false;
        await setRevealValue(measured, 'synthetic-new-value');
      }
      return true;
    },
    undefined,
    false,
    { observeStatements: true },
  );
  try {
    await setRevealValue(measured, revealValue);
    statements = 0;
    replace = true;
    const first = await revealSecret(measured);
    expect(first.status).toBe(200);
    expect(
      ((await first.json()) as { value: string }).value === revealValue,
    ).toBe(true);
    const second = await revealSecret(measured);
    expect(second.status).toBe(200);
    expect(
      ((await second.json()) as { value: string }).value ===
        'synthetic-new-value',
    ).toBe(true);
    expect(await auditRows(measured)).toHaveLength(2);
  } finally {
    await measured.close();
  }
});
it('E26: populated previous audit schema upgrades losslessly with both indexes and unchanged filters', async () => {
  const db = await app.mf.getD1Database('DB');
  const old = unstable_splitSqlQuery(
    await readFile('migrations/0007_secret_creations.sql', 'utf8'),
  );
  // 0007 rebuilds an existing table, so restore its resulting previous schema.
  await db.batch([
    db.prepare('DROP TABLE audit_entries'),
    db.prepare(
      (old[0] as string).replace('audit_entries_new', 'audit_entries'),
    ),
    db.prepare(
      'CREATE INDEX audit_entries_chronology ON audit_entries(at DESC, id DESC)',
    ),
    db.prepare(
      'CREATE INDEX audit_entries_secret ON audit_entries(path, at DESC, id DESC)',
    ),
    db.prepare(
      "DELETE FROM d1_migrations WHERE name='0008_secret_reveals.sql'",
    ),
  ]);
  for (const [index, outcome] of ['delivered', 'denied', 'created'].entries()) {
    await db
      .prepare(
        'INSERT INTO audit_entries(id, at, outcome, path, purpose, machine_id, machine_name, working_directory, executable, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        randomUUID(),
        `2026-10-08T0${index}:00:00.000Z`,
        outcome,
        revealPath,
        'previous activity',
        'old-machine',
        'previous laptop',
        '/previous',
        outcome === 'created' ? null : 'gh',
        outcome === 'created' ? null : 'previous-run',
      )
      .run();
  }
  const rows = await auditRows(app);
  const before = (await auditPageData(app)).entries;
  expect(await applyMigrations(db)).toEqual(['0008_secret_reveals.sql']);
  expect(
    (await auditRows(app)).map(
      ({ ip: _ip, country: _country, ...facts }) => facts,
    ),
  ).toEqual(rows);
  expect((await auditPageData(app)).entries).toEqual(before);
  for (const query of ['?bucket=work', '?secret=work%2Facme%2FSTRIPE_KEY'])
    expect((await auditPageData(app, query)).entries).toEqual(before);
  expect(
    (
      await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_entries' ORDER BY name",
        )
        .all<{ name: string }>()
    ).results.map((row) => row.name),
  ).toEqual([
    'audit_entries_chronology',
    'audit_entries_secret',
    'sqlite_autoindex_audit_entries_1',
  ]);
  expect((await revealSecret(app)).status).toBe(200);
  expect(
    (await auditPageData(app)).entries.map((entry) => entry.outcome),
  ).toEqual(['revealed', 'created', 'denied', 'delivered']);
});
it('E19: request URLs and successful audit/list responses contain metadata only', async () => {
  const url = `${app.origin}/api/secrets/${encodeURIComponent(revealPath)}/reveal`;
  expectNoValue(url, [revealValue]);
  expect((await revealSecret(app)).status).toBe(200);
  expectNoValue(
    JSON.stringify({
      rows: await auditRows(app),
      entries: (await auditPageData(app)).entries,
      metadata: await listSecrets(app),
    }),
    [revealValue, app.key],
  );
});
