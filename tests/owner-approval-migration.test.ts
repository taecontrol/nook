import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { expect, it } from 'vitest';
import {
  applyMigrations,
  migrationFiles,
  normalizedSchema,
  normalizeSchema,
} from '../scripts/lib/migrations.ts';
import { machineCreate, machineCreateInput } from './support/agent-create.ts';
import { previousSessionWorker } from './support/agent-sessions-previous-worker.ts';
import { acmePath, auditRows, fetchValues } from './support/audit.ts';
import { issueGrant } from './support/grants.ts';
import { createSecret, secretInput } from './support/vault.ts';

it('E1/E30: migration 0016 preserves historical claims, audit constraints, indexes and inserts from the previous Worker', async () => {
  const app = await previousSessionWorker('1927803');
  try {
    const db = await app.mf.getD1Database('DB');
    expect(
      await db
        .prepare(
          "SELECT name FROM d1_migrations WHERE name='0016_owner_approval.sql'",
        )
        .first(),
    ).not.toBeNull();
    const { token } = await issueGrant(app, ['work/acme']);
    await createSecret(app, secretInput({ name: 'GH_TOKEN' }));
    const claim = { agent: 'codex', session: 'migration-session' };
    expect(
      (await fetchValues(app, token, { agentSession: claim })).status,
    ).toBe(200);
    expect(
      (
        await fetchValues(app, token, {
          secrets: ['personal/X'],
          agentSession: claim,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await machineCreate(
          app,
          token,
          machineCreateInput({ agentSession: claim }),
        )
      ).status,
    ).toBe(201);
    const rows = await auditRows(app);
    expect(rows).toHaveLength(3);
    for (const row of rows)
      expect(row).toMatchObject({
        agent: claim.agent,
        agent_session: claim.session,
        approval_id: null,
        approval_remember: null,
      });
    const indexes = (
      await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE tbl_name='audit_entries'",
        )
        .all<{ name: string }>()
    ).results.map((r) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'audit_entries_chronology',
        'audit_entries_secret',
        'audit_entries_bucket',
        'audit_entries_agent_session',
        'audit_entries_assign_bucket',
      ]),
    );
    await expect(
      db
        .prepare('UPDATE audit_entries SET agent_session=NULL WHERE path=?')
        .bind(acmePath)
        .run(),
    ).rejects.toThrow(/CHECK constraint/);
  } finally {
    await app.close();
  }
});
it('E30: the populated 0015-to-0016 audit rebuild preserves all historical columns and the schema snapshot', async () => {
  const mf = new Miniflare({
    modules: true,
    cf: false,
    script: 'export default {fetch(){return new Response()}}',
    d1Databases: ['DB'],
    d1Persist: false,
  });
  try {
    const db = await mf.getD1Database('DB');
    const names = await migrationFiles('migrations');
    await applyMigrations(db, 'migrations', {
      only: names.filter((n) => n < '0016_owner_approval.sql'),
    });
    await db
      .prepare(
        "INSERT INTO audit_entries(id,at,outcome,path,bucket,purpose,machine_id,machine_name,working_directory,executable,run_id,agent,agent_session,agent_thread) VALUES ('kept','2026-11-02T12:00:00.000Z','delivered','work/acme/KEY','work/acme','kept purpose','machine','omarchy','/synthetic','node','run','codex','c1','thread')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO audit_entries(id,at,outcome,bucket,memory_id,file_name,file_size,file_sha256,client_name) VALUES ('kept-file','2026-11-02T12:00:00.000Z','file_attached','work/acme','12345678-1234-4123-8123-123456789012','file.pdf',1,lower(hex(zeroblob(32))),'test')",
      )
      .run();
    const before = (
      await db
        .prepare('SELECT * FROM audit_entries ORDER BY id')
        .all<Record<string, unknown>>()
    ).results;
    await applyMigrations(db);
    const after = (
      await db
        .prepare('SELECT * FROM audit_entries ORDER BY id')
        .all<Record<string, unknown>>()
    ).results;
    expect(after).toHaveLength(before.length);
    for (const row of before)
      expect(after.find((r) => r.id === row.id)).toMatchObject({
        ...row,
        approval_id: null,
        approval_remember: null,
      });
    expect(normalizeSchema(await normalizedSchema(db))).toBe(
      normalizeSchema(await readFile('migrations/schema.sql', 'utf8')),
    );
    await expect(
      db
        .prepare(
          "UPDATE audit_entries SET agent='codex',agent_session='c1' WHERE id='kept-file'",
        )
        .run(),
    ).rejects.toThrow(/CHECK constraint/);
  } finally {
    await mf.dispose();
  }
});
