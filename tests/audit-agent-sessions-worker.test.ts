import { beforeEach, expect, it } from 'vitest';
import { access, accessFixture } from './support/access.ts';
import { machineCreate, machineCreateInput } from './support/agent-create.ts';
import { codexClaim, codexSession } from './support/agent-session.ts';
import {
  acmePath,
  auditPageData,
  auditRows,
  fetchValues,
  runFixture,
} from './support/audit.ts';
import { issueGrant } from './support/grants.ts';
import { attachFile, seedFileMemory } from './support/memory-files.ts';
import { seedPreviousAudit } from './support/memory-files-audit.ts';
import { filesRuntime } from './support/memory-files-runtime.ts';
import { revealSecret } from './support/reveal.ts';
import { createSecret, expectNoValue, secretInput } from './support/vault.ts';

let app: Awaited<ReturnType<typeof runFixture>>;
beforeEach(async () => {
  app = await runFixture();
  return () => app.close();
});
it('E10: outside-grant denial preserves the claim without delivering a value', async () => {
  const input = secretInput({ bucket: 'personal', name: 'PRIVATE_KEY' });
  expect((await createSecret(app, input)).status).toBe(201);
  const response = await fetchValues(app, app.token, {
    secrets: ['personal/PRIVATE_KEY'],
    agentSession: codexClaim,
  });
  expect(response.status).toBe(403);
  expectNoValue(await response.text(), [input.value]);
  expect((await auditPageData(app)).entries[0]).toMatchObject({
    outcome: 'denied',
    agentSession: codexClaim,
  });
});
const invalidContent = [
  { label: 'space', claim: { ...codexClaim, session: 'a b' }, expected: null },
  {
    label: 'overlong',
    claim: { ...codexClaim, session: 'a'.repeat(201) },
    expected: null,
  },
  {
    label: 'bad agent slug',
    claim: { ...codexClaim, agent: 'Bad Agent' },
    expected: null,
  },
  {
    label: 'invalid thread only',
    claim: { ...codexClaim, thread: 'a b' },
    expected: { agent: 'codex', session: codexSession },
  },
];
it.each(
  invalidContent.flatMap((sample) =>
    ['run', 'create'].map((operation) => ({ ...sample, operation })),
  ),
)(
  'E13: $operation drops $label without failing the operation',
  async ({ claim, expected, operation }) => {
    const response =
      operation === 'run'
        ? await fetchValues(app, app.token, { agentSession: claim })
        : await machineCreate(
            app,
            app.token,
            machineCreateInput({ agentSession: claim }),
          );
    expect(response.status).toBe(operation === 'run' ? 200 : 201);
    if (operation === 'run')
      expect(await response.json()).toMatchObject({
        values: [{ path: acmePath, value: app.input.value }],
      });
    expect((await auditPageData(app)).entries[0]).toHaveProperty(
      'agentSession',
      expected,
    );
  },
);
it.each(
  [
    5,
    { agent: 'codex', session: 7 },
    { agent: 7, session: codexSession },
    { ...codexClaim, thread: false },
  ].flatMap((claim, index) =>
    ['run', 'create'].map((operation) => ({ claim, index, operation })),
  ),
)(
  'E13: $operation rejects structurally malformed claim $index before delivery or audit',
  async ({ claim, operation }) => {
    const response =
      operation === 'run'
        ? await fetchValues(app, app.token, { agentSession: claim })
        : await machineCreate(
            app,
            app.token,
            machineCreateInput({ agentSession: claim }),
          );
    expect(response.status).toBe(400);
    expectNoValue(await response.text(), [app.input.value]);
    expect(await auditRows(app)).toEqual([]);
  },
);
it('E14: session filtering ANDs bucket and secret, groups all threads and pages without gaps or repeats', async () => {
  const { token } = await issueGrant(app);
  expect(
    (await createSecret(app, secretInput({ bucket: 'work', name: 'OTHER' })))
      .status,
  ).toBe(201);
  for (let index = 0; index < 32; index++) {
    const response = await fetchValues(app, token, {
      secrets: [index % 3 ? acmePath : 'work/OTHER'],
      agentSession: { ...codexClaim, thread: `thread-${index}` },
    });
    expect(response.status).toBe(200);
    await response.body?.cancel();
  }
  await fetchValues(app, token, {
    agentSession: { agent: 'declared', session: 'other-session' },
  });
  await fetchValues(app, token);
  const stored = (await auditRows(app)).filter(
    (row) => row.agent_session === codexSession,
  );
  const entries: { id: string }[] = [];
  let cursor: string | null = null;
  do {
    const page = await auditPageData(
      app,
      `?session=${codexSession}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    if (!cursor) expect(page.entries).toHaveLength(25);
    entries.push(...page.entries);
    cursor = page.next;
  } while (cursor);
  expect(entries.map((entry) => entry.id)).toEqual(stored.map((row) => row.id));
  expect(new Set(entries.map((entry) => entry.id)).size).toBe(32);
  const scoped = await auditPageData(
    app,
    `?session=${codexSession}&bucket=work%2Facme&secret=${encodeURIComponent(acmePath)}`,
  );
  expect(scoped.entries.map((entry) => entry.id)).toEqual(
    stored.filter((row) => row.path === acmePath).map((row) => row.id),
  );
  expect(
    (
      await auditPageData(
        app,
        `?session=${codexSession}&bucket=personal&secret=${encodeURIComponent(acmePath)}`,
      )
    ).entries,
  ).toEqual([]);
});
it.each(['a%20b', '', 'a'.repeat(201), '%C3%B1'])(
  'E14: malformed session %s is InvalidAuditFilter',
  async (session) => {
    const response = await fetch(`${app.origin}/api/audit?session=${session}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ _tag: 'InvalidAuditFilter' });
  },
);
it('E14: a machine cannot list session activity', async () => {
  const issuer = await accessFixture();
  await app.setBindings(
    { ...access, VAULT_KEY: app.key },
    { outboundService: issuer.outboundService },
  );
  // Preserve the existing Access-auth behavior for a bearer on an owner route.
  expect(
    (
      await fetch(`${app.origin}/api/audit?session=${codexSession}`, {
        headers: { Authorization: `Bearer ${app.token}` },
      })
    ).status,
  ).toBe(401);
});
it('E14: an owner principal with a limited grant cannot list session activity', async () => {
  const limited = await filesRuntime({ principalGrant: ['work/acme'] });
  try {
    expect(
      (await fetch(`${limited.origin}/api/audit?session=${codexSession}`))
        .status,
    ).toBe(403);
  } finally {
    await limited.close();
  }
});
it('E15: historical machine entries read null and revealed entries have no claim field', async () => {
  await seedPreviousAudit(await app.mf.getD1Database('DB'));
  expect((await revealSecret(app, acmePath)).status).toBe(200);
  for (const entry of (await auditPageData(app)).entries) {
    if (entry.outcome === 'revealed')
      expect(entry).not.toHaveProperty('agentSession');
    else expect(entry).toHaveProperty('agentSession', null);
  }
});
it('E15: memory file audit entries never carry an agent session', async () => {
  const files = await filesRuntime();
  try {
    const machine = await seedFileMemory(files);
    await attachFile(files, machine.token);
    const page = (await (await fetch(`${files.origin}/api/audit`)).json()) as {
      entries: Record<string, unknown>[];
    };
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0].outcome).toBe('file_attached');
    expect(page.entries[0]).not.toHaveProperty('agentSession');
  } finally {
    await files.close();
  }
});
