import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Effect } from 'effect';
import { Log, LogLevel } from 'miniflare';
import { beforeEach, expect, expectTypeOf, it } from 'vitest';
import { unstable_splitSqlQuery } from 'wrangler';
import type { machineVault } from '../apps/worker/src/vault.ts';
import { applyMigrations } from '../scripts/lib/migrations.ts';
import { access, accessFixture } from './support/access.ts';
import {
  createdPath,
  machineCreate,
  machineCreateInput,
} from './support/agent-create.ts';
import { auditPageData, auditRows } from './support/audit.ts';
import { issueGrant, machineMcp } from './support/grants.ts';
import { listMachines, revokeMachine } from './support/machines.ts';
import {
  createSecret,
  decryptRow,
  deleteSecret,
  expectNoValue,
  replaceSecret,
  secretInput,
  secretRows,
  vaultRuntime,
} from './support/vault.ts';
import { vaultCheckpoints } from './support/vault-checkpoints.ts';

let app: Awaited<ReturnType<typeof vaultRuntime>>;
beforeEach(async () => {
  app = await vaultRuntime();
  return () => app.close();
});
it('E1/E4/E20: create returns public metadata, encrypted storage and one private creation ledger entry', async () => {
  const { token } = await issueGrant(app, ['work/acme']);
  const [machine] = await listMachines(app);
  const input = machineCreateInput();
  const started = Date.now();
  const response = await machineCreate(app, token, input);
  expect(response.status).toBe(201);
  const text = await response.text();
  expectNoValue(text, [input.value, token, app.key]);
  const metadata = JSON.parse(text);
  expect(Object.keys(metadata).sort()).toEqual([
    'bucket',
    'description',
    'name',
    'path',
    'updatedAt',
  ]);
  expect(metadata).toMatchObject({
    path: createdPath,
    description: input.description,
  });
  const [row] = await secretRows(app);
  expect((await decryptRow(app.key, row)) === input.value).toBe(true);
  const entries = (await auditPageData(app)).entries;
  expectNoValue(JSON.stringify({ row, entries }), [
    input.value,
    token,
    app.key,
  ]);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    id: input.writeId,
    outcome: 'created',
    path: createdPath,
    purpose: input.purpose,
    machine: { id: machine.id, name: machine.name },
    workingDirectory: input.workingDirectory,
  });
  expect(Object.keys(entries[0]).sort()).toEqual([
    'at',
    'bucket',
    'id',
    'machine',
    'name',
    'outcome',
    'path',
    'purpose',
    'workingDirectory',
  ]);
  expect(
    Date.parse(entries[0].at) >= started &&
      Date.parse(entries[0].at) <= Date.now(),
  ).toBe(true);
  const [audit] = await auditRows(app);
  expectNoValue(JSON.stringify(audit), [input.value, token, app.key]);
  expect(audit.executable).toBeNull();
  expect(audit.run_id).toBeNull();
  const discovery = await machineMcp(app, token).call('list_secrets', {
    bucket: 'work/acme',
  });
  expectNoValue(JSON.stringify(discovery), [input.value, token, app.key]);
  expect(discovery.structuredContent!.secrets).toEqual([metadata]);
  expectNoValue(text + JSON.stringify({ row, audit, entries, discovery }), [
    input.value,
    token,
    app.key,
  ]);
});
it('E5: an existing name preserves all bytes and metadata and adds no audit entry', async () => {
  const { token } = await issueGrant(app, ['work/acme']);
  expect(
    (await createSecret(app, secretInput({ name: 'NEW_TOKEN' }))).status,
  ).toBe(201);
  const before = await secretRows(app);
  const input = machineCreateInput();
  const response = await machineCreate(app, token, input);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    _tag: 'SecretExists',
    message: `${createdPath} already exists.`,
  });
  expect(await secretRows(app)).toEqual(before);
  expect(await auditRows(app)).toEqual([]);
});
it.each(['personal', 'personal/missing', 'work', 'me', 'work/acme-old'])(
  'E6: deny create in %s before SQL, without storing or auditing a denied attempt',
  async (bucket) => {
    const labels: string[] = [];
    const measured = await vaultCheckpoints(async (label) => {
      labels.push(label);
      return true;
    });
    try {
      const { token } = await issueGrant(measured, ['work/acme']);
      labels.length = 0;
      expect(
        (await machineCreate(measured, token, machineCreateInput({ bucket })))
          .status,
      ).toBe(403);
      expect(labels).toEqual(['/statement']);
      expect(await secretRows(measured)).toEqual([]);
      expect(await auditRows(measured)).toEqual([]);
    } finally {
      await measured.close();
    }
  },
);
it('E7: a missing bucket inside the grant returns BucketNotFound without audit', async () => {
  const { token } = await issueGrant(app, ['work/acme']);
  const response = await machineCreate(
    app,
    token,
    machineCreateInput({ bucket: 'work/acme/missing' }),
  );
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    _tag: 'BucketNotFound',
    message: 'Bucket not found.',
  });
  expect(await secretRows(app)).toEqual([]);
  expect(await auditRows(app)).toEqual([]);
});
it.each(
  [
    { value: '' },
    { value: '\0' },
    { value: 'a'.repeat(65537) },
    { value: '\ud800' },
    { name: 'bad-name' },
    { bucket: 'Bad' },
    { description: 'two\nlines' },
    { description: 'a'.repeat(201) },
    { purpose: '' },
    { purpose: ' ' },
    { purpose: 'two\nlines' },
    { purpose: 'a'.repeat(201) },
    { workingDirectory: 'relative' },
    { purpose: undefined },
    { workingDirectory: undefined },
    { writeId: 'bad-id' },
  ].map((overrides, index) => ({ overrides, index })),
)(
  'E9/E20: bypassed invalid payload $index is rejected privately without changing rows',
  async ({ overrides }) => {
    const { token } = await issueGrant(app, ['work/acme']);
    const input = machineCreateInput(overrides);
    const response = await machineCreate(app, token, input);
    expect(response.status).toBe(400);
    const text = await response.text();
    if (input.value.length > 1) expectNoValue(text, [input.value]);
    expect(['InvalidSecret', 'InvalidRun']).toContain(JSON.parse(text)._tag);
    expect(await secretRows(app)).toEqual([]);
    expect(await auditRows(app)).toEqual([]);
  },
);
it('E9/E20: raw invalid UTF-8 in a JSON value is rejected without storing replacement bytes', async () => {
  const { token } = await issueGrant(app, ['work/acme']);
  const input = machineCreateInput();
  const encoded = Buffer.from(JSON.stringify(input));
  const value = Buffer.from(JSON.stringify(input.value));
  const offset = encoded.indexOf(value);
  const body = Buffer.concat([
    encoded.subarray(0, offset + 1),
    Buffer.from([0xc3, 0x28]),
    encoded.subarray(offset + value.length - 1),
  ]);
  const response = await fetch(`${app.origin}/api/machine/secrets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body,
  });
  expect(response.status).toBe(400);
  const text = await response.text();
  expectNoValue(text, [input.value, token, app.key]);
  expect(JSON.parse(text)._tag).toBe('InvalidSecret');
  expect(await secretRows(app)).toEqual([]);
  expect(await auditRows(app)).toEqual([]);
});
it('E11/E20: machine create authenticates only valid Nook tokens, without leaking schema failures', async () => {
  const { token } = await issueGrant(app, ['work/acme']);
  const input = machineCreateInput();
  for (const credential of [undefined, 'malformed', `nook_${'z'.repeat(43)}`]) {
    expect((await machineCreate(app, credential, input)).status).toBe(401);
  }
  const issuer = await accessFixture();
  await app.setBindings(
    { ...access, VAULT_KEY: app.key },
    { outboundService: issuer.outboundService },
  );
  const owner = { 'Cf-Access-Jwt-Assertion': await issuer.assertion() };
  expect((await machineCreate(app, undefined, input, owner)).status).toBe(401);
  expect(
    (await revokeMachine(app, (await listMachines(app, owner))[0].id, owner))
      .status,
  ).toBe(204);
  expect((await machineCreate(app, token, input)).status).toBe(401);
  const malformed = await machineCreate(
    app,
    token,
    machineCreateInput({ purpose: undefined, writeId: 'bad-id' }),
  );
  expect(malformed.status).toBe(400);
  expectNoValue(await malformed.text(), [input.value, token, app.key]);
  expect(await secretRows(app)).toEqual([]);
  expect(await auditRows(app)).toEqual([]);
});
it.each(['all', ['work/acme']] as const)(
  'E12: grant %s never gives a Nook Bearer owner replace/delete or a machine mutation route',
  async (grant) => {
    const input = secretInput({ name: 'NEW_TOKEN' });
    expect((await createSecret(app, input)).status).toBe(201);
    const { token } = await issueGrant(app, grant);
    const before = await secretRows(app);
    await app.setBindings({ VAULT_KEY: app.key });
    const headers = { Authorization: `Bearer ${token}` };
    for (const response of [
      await replaceSecret(
        app,
        createdPath,
        { ...secretInput(), expectedVersion: input.writeId },
        headers,
      ),
      await deleteSecret(app, createdPath, input.writeId, headers),
    ])
      expect([401, 403]).toContain(response.status);
    for (const method of ['PUT', 'DELETE']) {
      const response = await fetch(
        `${app.origin}/api/machine/secrets/${encodeURIComponent(createdPath)}`,
        { method, headers },
      );
      expect([404, 405]).toContain(response.status);
    }
    expect(await secretRows(app)).toEqual(before);
    expect(await auditRows(app)).toEqual([]);
  },
);
it('E13: machineVault exposes no read value, replace or remove capability', async () => {
  type MachineFace = Effect.Success<ReturnType<typeof machineVault>>;
  expectTypeOf<
    Extract<keyof MachineFace, 'reveal' | 'values' | 'replace' | 'remove'>
  >().toEqualTypeOf<never>();
  const source = await readFile('apps/worker/src/vault.ts', 'utf8');
  expect(source).toContain('no value read, replace, or remove capability');
});
it('E14/E15: secret and audit share one batch, failed commits change neither and id replays preserve both', async () => {
  let stage = '';
  const labels: string[] = [];
  const measured = await vaultCheckpoints(async (label) => {
    labels.push(label);
    return label !== stage;
  });
  try {
    const { token } = await issueGrant(measured, ['work/acme']);
    const input = machineCreateInput();
    stage = '/before-batch';
    labels.length = 0;
    expect((await machineCreate(measured, token, input)).status).toBe(503);
    expect(labels).toEqual(['/statement', '/before-batch']);
    expect(await secretRows(measured)).toEqual([]);
    expect(await auditRows(measured)).toEqual([]);
    stage = '/after-batch';
    expect((await machineCreate(measured, token, input)).status).toBe(503);
    const rows = await secretRows(measured);
    const audits = await auditRows(measured);
    expect(rows).toHaveLength(1);
    expect(audits).toHaveLength(1);
    stage = '';
    labels.length = 0;
    const replay = await machineCreate(measured, token, {
      ...input,
      value: 'changed-payload',
      description: 'changed-description',
    });
    expect(replay.status).toBe(201);
    expect(labels).toEqual(['/statement', '/before-batch', '/after-batch']);
    expect(await secretRows(measured)).toEqual(rows);
    expect(await auditRows(measured)).toEqual(audits);
  } finally {
    await measured.close();
  }
});
it('E16: an owner replacement prevents a previous writeId from confirming or changing the newer row', async () => {
  const { token } = await issueGrant(app, ['work/acme']);
  const input = machineCreateInput();
  expect((await machineCreate(app, token, input)).status).toBe(201);
  expect(
    (
      await replaceSecret(app, createdPath, {
        ...secretInput(),
        expectedVersion: input.writeId,
      })
    ).status,
  ).toBe(200);
  const before = await secretRows(app);
  expect((await machineCreate(app, token, input)).status).toBe(409);
  expect(await secretRows(app)).toEqual(before);
  expect(await auditRows(app)).toHaveLength(1);
});
it('E20: genuine storage failures never expose the value in errors or Worker logs', async () => {
  const logs: string[] = [];
  class PrivateLog extends Log {
    protected log(message: string) {
      logs.push(message);
    }
  }
  const log = new PrivateLog(LogLevel.DEBUG);
  await app.setBindings(app.bindings, {
    log,
    handleRuntimeStdio: (stdout, stderr) => {
      for (const stream of [stdout, stderr])
        stream.on('data', (chunk) => logs.push(String(chunk)));
    },
  });
  const { token } = await issueGrant(app, ['work/acme']);
  const db = await app.mf.getD1Database('DB');
  await db
    .prepare('ALTER TABLE audit_entries RENAME TO unavailable_audit_entries')
    .run();
  const input = machineCreateInput();
  const response = await machineCreate(app, token, input);
  expect(response.status).toBe(503);
  expectNoValue((await response.text()) + logs.join(''), [
    input.value,
    token,
    app.key,
  ]);
  expect(await secretRows(app)).toEqual([]);
});
it('Migration preserves populated use rows and chronology/path indexes while allowing creations', async () => {
  const db = await app.mf.getD1Database('DB');
  const old = unstable_splitSqlQuery(
    await readFile('migrations/0006_audit_entries.sql', 'utf8'),
  );
  await db.batch([
    db.prepare('DROP TABLE audit_entries'),
    ...old.map((sql) => db.prepare(sql)),
    db.prepare(
      "DELETE FROM d1_migrations WHERE name='0007_secret_creations.sql'",
    ),
  ]);
  const id = randomUUID();
  await db
    .prepare('INSERT INTO audit_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(
      id,
      '2026-10-07T00:00:00.000Z',
      'delivered',
      createdPath,
      'previous use',
      'old-machine',
      'previous laptop',
      '/previous',
      'gh',
      'previous-run',
    )
    .run();
  const before = await auditRows(app);
  expect(await applyMigrations(db)).toEqual(['0007_secret_creations.sql']);
  expect(await auditRows(app)).toEqual(before);
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
  const { token } = await issueGrant(app, ['work/acme']);
  expect((await machineCreate(app, token)).status).toBe(201);
  expect(
    (await auditPageData(app)).entries.map((entry) => entry.outcome),
  ).toEqual(['created', 'delivered']);
});
