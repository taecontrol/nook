import { beforeEach, expect, it } from 'vitest';
import { access, accessFixture } from './support/access.ts';
import { issueGrant, machineMcp } from './support/grants.ts';
import { listMachines, revokeMachine } from './support/machines.ts';
import { expectToolError, mcpDriver, type ToolResult } from './support/mcp.ts';
import {
  expectNoValue,
  seedSecrets,
  vaultRuntime,
  visibleAcme,
} from './support/vault.ts';
import { vaultCheckpoints } from './support/vault-checkpoints.ts';

let app: Awaited<ReturnType<typeof vaultRuntime>>;
beforeEach(async () => {
  app = await vaultRuntime();
  return () => app.close();
});
function paths(result: ToolResult) {
  expect(result.isError).not.toBe(true);
  if (!result.structuredContent)
    throw new Error('MCP must return structured metadata.');
  return (result.structuredContent.secrets as { path: string }[]).map(
    (secret) => secret.path,
  );
}
it.each(['2026-07-28', '2025-06-18'] as const)(
  'E12: %s owner MCP lists nearest ancestors by name without any encoded value or version',
  async (protocol) => {
    const values = await seedSecrets(app);
    const result = await mcpDriver(app.origin, protocol).call('list_secrets', {
      bucket: 'work/acme',
    });
    expect(paths(result)).toEqual(visibleAcme);
    for (const entry of result.structuredContent!.secrets as Record<
      string,
      unknown
    >[])
      expect(Object.keys(entry).sort()).toEqual([
        'bucket',
        'description',
        'name',
        'path',
        'updatedAt',
      ]);
    expectNoValue(JSON.stringify(result), values);
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(result.structuredContent) },
    ]);
  },
);
it('E13: limited machine reads its root, descendants and ancestors, denying siblings and other roots', async () => {
  await seedSecrets(app);
  const { token } = await issueGrant(app, ['work/acme']);
  const driver = machineMcp(app, token);
  expect(
    paths(await driver.call('list_secrets', { bucket: 'work/acme' })),
  ).toEqual(visibleAcme);
  expect(paths(await driver.call('list_secrets', { bucket: 'work' }))).toEqual(
    visibleAcme.slice(4),
  );
  for (const bucket of ['personal/finances', 'work/globex'])
    expectToolError(
      await driver.call('list_secrets', { bucket }),
      'Access to this bucket is forbidden.',
    );
  expect(
    paths(
      await driver.call('list_secrets', {
        bucket: 'work/acme/billing-service',
      }),
    ),
  ).toEqual([
    'work/acme/billing-service/CLOUDFLARE_API_TOKEN_FOR_BILLING_SERVICE_PRODUCTION_DEPLOYS',
    ...visibleAcme,
  ]);
  const other = await issueGrant(app, ['personal']);
  expectToolError(
    await machineMcp(app, other.token).call('list_secrets', {
      bucket: 'work/acme',
    }),
    'Access to this bucket is forbidden.',
  );
});
it('E14: missing buckets disclose existence only within the grant and paths retain shared validation', async () => {
  const { token } = await issueGrant(app, ['work/acme']);
  const driver = machineMcp(app, token);
  expectToolError(
    await driver.call('list_secrets', { bucket: 'work/acme/missing' }),
    'Bucket not found.',
  );
  expectToolError(
    await driver.call('list_secrets', { bucket: 'personal/missing' }),
    'Access to this bucket is forbidden.',
  );
  expectToolError(
    await driver.call('list_secrets', { bucket: 'Work' }),
    'Use lowercase letters: work',
  );
});
it('E14: grant denial precedes D1 and cannot reveal an outside missing bucket', async () => {
  const labels: string[] = [];
  const measured = await vaultCheckpoints(async (label) => {
    labels.push(label);
    return true;
  });
  try {
    const { token } = await issueGrant(measured, ['work/acme']);
    for (const bucket of ['personal/finances', 'personal/missing']) {
      labels.length = 0;
      expectToolError(
        await machineMcp(measured, token).call('list_secrets', { bucket }),
        'Access to this bucket is forbidden.',
      );
      expect(labels).toEqual(['/statement']);
    }
  } finally {
    await measured.close();
  }
});
it('E15: the read-only tool requires a bucket and teaches metadata-only ancestor discovery', async () => {
  const { tools } = await mcpDriver(app.origin).listTools();
  const tool = tools.find((entry) => entry.name === 'list_secrets');
  expect(tool).toBeDefined();
  expect(tool!.annotations.readOnlyHint).toBe(true);
  expect(tool!.inputSchema.required).toEqual(['bucket']);
  expect(tool!.description).toMatch(/names and descriptions/i);
  expect(tool!.description).toMatch(/ancestors/i);
  expect(tool!.description).toMatch(/never values/i);
  expect(tool!.description).toMatch(
    /must not ask the owner for (?:a |the )?value/i,
  );
  expect(tool!.description).not.toContain('nook run');
  expect(
    tools
      .filter((entry) => /secret/.test(entry.name))
      .map((entry) => entry.name),
  ).toEqual(['list_secrets']);
  const missing = await mcpDriver(app.origin).call('list_secrets');
  expect(missing.isError).toBe(true);
});
it('E16: machine HTTP requires its Bearer and returns the same authorized metadata', async () => {
  const values = await seedSecrets(app);
  const { token } = await issueGrant(app, ['work/acme']);
  const get = (bucket: string, headers: HeadersInit = {}) =>
    fetch(
      `${app.origin}/api/machine/secrets?bucket=${encodeURIComponent(bucket)}`,
      { headers },
    );
  expect((await get('work/acme')).status).toBe(401);
  for (const credential of [
    'Bearer malformed',
    `Bearer nook_${'z'.repeat(43)}`,
  ])
    expect((await get('work/acme', { Authorization: credential })).status).toBe(
      401,
    );
  const issuer = await accessFixture();
  await app.setBindings(
    { ...access, VAULT_KEY: app.key },
    { outboundService: issuer.outboundService },
  );
  expect(
    (
      await get('work/acme', {
        'Cf-Access-Jwt-Assertion': await issuer.assertion(),
      })
    ).status,
  ).toBe(401);
  const headers = { Authorization: `Bearer ${token}` };
  const response = await get('work/acme', headers);
  expect(response.status).toBe(200);
  const text = await response.text();
  expectNoValue(text, values);
  const body = JSON.parse(text) as { secrets: { path: string }[] };
  expect(body.secrets.map((secret) => secret.path)).toEqual(visibleAcme);
  expect((await get('personal/finances', headers)).status).toBe(403);
  expect((await get('work/acme/missing', headers)).status).toBe(404);
  const owner = { 'Cf-Access-Jwt-Assertion': await issuer.assertion() };
  expect(
    (await revokeMachine(app, (await listMachines(app, owner))[0].id, owner))
      .status,
  ).toBe(204);
  expect((await get('work/acme', headers)).status).toBe(401);
});
