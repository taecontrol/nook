import { expect, it } from 'vitest';
import * as contract from '../packages/contract/src/index.ts';
import { runtimeOptions } from '../scripts/runtime.ts';
import { createArgs } from './support/agent-create.ts';
import {
  app,
  configure,
  keyring,
  setupAgentCreateCli,
} from './support/agent-create-cli.ts';
import { codexClaim, codexSession } from './support/agent-session.ts';
import { previousSessionWorker } from './support/agent-sessions-previous-worker.ts';
import {
  acmePath,
  auditPageData,
  auditRows,
  fetchValues,
} from './support/audit.ts';
import { issueGrant } from './support/grants.ts';
import { testBuild } from './support/runtime.ts';
import { createSecret, secretInput } from './support/vault.ts';

setupAgentCreateCli();
it('E16: previous Worker delivers, denies and creates on 0014; new CLI succeeds and new Worker reads null claims', async () => {
  const previous = await previousSessionWorker();
  try {
    const db = await previous.mf.getD1Database('DB');
    expect(
      await db
        .prepare(
          "SELECT name FROM d1_migrations WHERE name='0014_audit_agent_sessions.sql'",
        )
        .first(),
    ).not.toBeNull();
    const { token } = await issueGrant(previous, ['work/acme']);
    expect(
      (await createSecret(previous, secretInput({ name: 'GH_TOKEN' }))).status,
    ).toBe(201);
    expect(
      (
        await fetchValues(previous, token, {
          secrets: ['personal/PRIVATE_KEY'],
          agentSession: codexClaim,
        })
      ).status,
    ).toBe(403);
    await configure(previous.origin, token);
    const env = { CODEX_SESSION_ID: codexSession };
    expect(
      (
        await keyring.start(
          [
            'run',
            '--secret',
            `T=${acmePath}`,
            '--purpose',
            'previous worker',
            '--',
            process.execPath,
            '-e',
            '',
          ],
          env,
        ).done
      ).status,
    ).toBe(0);
    expect(
      (await keyring.start(createArgs(), env, secretInput().value).done).status,
    ).toBe(0);
    expect((await fetchValues(previous, token)).status).toBe(200);
    const rows = await auditRows(previous);
    expect(rows.map((row) => row.outcome).sort()).toEqual([
      'created',
      'delivered',
      'delivered',
      'denied',
    ]);
    for (const row of rows)
      expect(row).toMatchObject({
        agent: null,
        agent_session: null,
        agent_thread: null,
      });
    await previous.mf.setOptions(
      runtimeOptions({
        port: Number(new URL(previous.origin).port),
        directory: testBuild,
        bindings: previous.bindings,
        coverage: Boolean(process.env.COVERAGE_RUN),
      }),
    );
    for (const entry of (await auditPageData(previous)).entries)
      expect(entry).toHaveProperty('agentSession', null);
  } finally {
    await previous.close();
  }
});
it('E17: D1 rejects claims on revealed/file rows, incomplete or invalid claims, and redundant threads', async () => {
  const db = await app.mf.getD1Database('DB');
  // Require the actual migration, rather than allowing a missing column to count as a rejection.
  expect(
    (
      await db
        .prepare('PRAGMA table_info(audit_entries)')
        .all<{ name: string }>()
    ).results.map((row) => row.name),
  ).toEqual(expect.arrayContaining(['agent', 'agent_session', 'agent_thread']));
  expect((await fetchValues(app, (await issueGrant(app)).token)).status).toBe(
    404,
  );
  await db
    .prepare(
      "INSERT INTO audit_entries(id,at,outcome,path,bucket,purpose,machine_id,machine_name,working_directory,executable,run_id) VALUES ('constraint-machine','2026-11-02','delivered','work/acme/X','work/acme','test','m','machine','/test','node','run')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO audit_entries(id,at,outcome,path,bucket,purpose) VALUES ('constraint-reveal','2026-11-02','revealed','work/acme/X','work/acme','test')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO audit_entries(id,at,outcome,bucket,memory_id,file_name,file_size,file_sha256,client_name) VALUES ('constraint-file','2026-11-02','file_attached','work/acme','memory','x.pdf',1,'sha','test')",
    )
    .run();
  for (const [id, agent, session, thread] of [
    ['constraint-reveal', 'codex', 'session', null],
    ['constraint-file', 'codex', 'session', null],
    ['constraint-machine', 'codex', null, null],
    ['constraint-machine', null, 'session', null],
    ['constraint-machine', 'Bad Agent', 'session', null],
    ['constraint-machine', 'a'.repeat(33), 'session', null],
    ['constraint-machine', 'codex', 'a'.repeat(201), null],
    ['constraint-machine', 'codex', 'a b', null],
    ['constraint-machine', 'codex', 'session', 'session'],
    ['constraint-machine', 'codex', 'session', 'a b'],
  ])
    await expect(
      db
        .prepare(
          'UPDATE audit_entries SET agent=?,agent_session=?,agent_thread=? WHERE id=?',
        )
        .bind(agent, session, thread, id)
        .run(),
    ).rejects.toThrow(/CHECK constraint/);
});
it('E17: every generated claim accepted by the shared validator passes the D1 constraints', async () => {
  const db = await app.mf.getD1Database('DB');
  await db
    .prepare(
      "INSERT INTO audit_entries(id,at,outcome,path,bucket,purpose,machine_id,machine_name,working_directory) VALUES ('property','2026-11-02','created','work/acme/X','work/acme','test','m','machine','/test')",
    )
    .run();
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:~-';
  const values = [
    codexSession,
    'a',
    'a'.repeat(200),
    ...Array.from({ length: 200 }, (_, index) =>
      Array.from(
        { length: 1 + (index % 200) },
        (_, at) => alphabet[(index * 31 + at * 17) % alphabet.length],
      ).join(''),
    ),
  ];
  for (const [index, session] of values.entries()) {
    const claim = contract.normalizeAgentSession({
      agent: index % 2 ? 'future-harness-2' : 'codex',
      session,
      thread: index % 3 ? `thread_${index}` : session,
    });
    expect(claim).not.toBeNull();
    await expect(
      db
        .prepare(
          'UPDATE audit_entries SET agent=?,agent_session=?,agent_thread=? WHERE id=?',
        )
        .bind(claim!.agent, claim!.session, claim!.thread ?? null, 'property')
        .run(),
    ).resolves.toMatchObject({ success: true });
  }
});
