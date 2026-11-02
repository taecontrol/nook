import { expect, it } from 'vitest';
import { machineCreate, machineCreateInput } from './support/agent-create.ts';
import { previousSessionWorker } from './support/agent-sessions-previous-worker.ts';
import { acmePath, auditRows, fetchValues } from './support/audit.ts';
import { issueGrant } from './support/grants.ts';
import { createSecret, secretInput } from './support/vault.ts';

it('E1/E30: migration 0015 preserves historical claims, audit constraints, indexes and inserts from the previous Worker', async () => {
  const app = await previousSessionWorker('1927803');
  try {
    const db = await app.mf.getD1Database('DB');
    expect(
      await db
        .prepare(
          "SELECT name FROM d1_migrations WHERE name='0015_owner_approval.sql'",
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
          secrets: ['me/X'],
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
