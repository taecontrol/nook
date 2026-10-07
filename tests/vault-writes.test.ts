import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it } from 'vitest';
import { issueGrant, machineMcp } from './support/grants.ts';
import { mcpDriver } from './support/mcp.ts';
import {
  createSecret,
  decryptRow,
  deleteSecret,
  listSecrets,
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
async function original() {
  const input = secretInput();
  expect((await createSecret(app, input)).status).toBe(201);
  return { input, path: 'work/acme/STRIPE_KEY' };
}
it('E27: create and replace resends return original metadata and ignore changed replay payloads', async () => {
  const { input, path } = await original();
  const [created] = await listSecrets(app);
  let before = await secretRows(app);
  const resend = await createSecret(app, {
    ...input,
    value: 'synthetic-different-replay',
  });
  expect(resend.status).toBe(201);
  expect(await resend.json()).toEqual(created);
  expect(await secretRows(app)).toEqual(before);
  const replacement = { ...secretInput(), expectedVersion: input.writeId };
  const changed = await replaceSecret(app, path, replacement);
  expect(changed.status).toBe(200);
  const metadata = await changed.json();
  before = await secretRows(app);
  const replay = await replaceSecret(app, path, {
    ...replacement,
    value: 'synthetic-another-replay',
  });
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(metadata);
  expect(await secretRows(app)).toEqual(before);
  const changedVersionReplay = await replaceSecret(app, path, {
    ...replacement,
    value: 'synthetic-third-replay',
    expectedVersion: replacement.writeId,
  });
  expect(changedVersionReplay.status).toBe(200);
  expect(await changedVersionReplay.json()).toEqual(metadata);
  expect(await secretRows(app)).toEqual(before);
  expect((await deleteSecret(app, path, replacement.writeId)).status).toBe(204);
  expect((await deleteSecret(app, path, replacement.writeId)).status).toBe(404);
});
it.each(
  ['create', 'replace', 'delete'].flatMap((operation) =>
    ['before-batch', 'after-batch'].map((stage) => ({ operation, stage })),
  ),
)(
  'E27: $operation survives a D1 failure $stage with one applied change',
  async ({ operation, stage }) => {
    let fail = false;
    const measured = await vaultCheckpoints(
      async (label) => !(fail && label === `/${stage}`),
    );
    try {
      const input = secretInput();
      if (operation !== 'create')
        expect((await createSecret(measured, input)).status).toBe(201);
      const replacement = { ...secretInput(), expectedVersion: input.writeId };
      const send = () =>
        operation === 'create'
          ? createSecret(measured, input)
          : operation === 'replace'
            ? replaceSecret(measured, 'work/acme/STRIPE_KEY', replacement)
            : deleteSecret(measured, 'work/acme/STRIPE_KEY', input.writeId);
      fail = true;
      expect((await send()).status).toBe(503);
      const afterFailure = await secretRows(measured);
      fail = false;
      expect((await send()).status).toBe(
        operation === 'create'
          ? 201
          : operation === 'replace'
            ? 200
            : stage === 'after-batch'
              ? 404
              : 204,
      );
      const rows = await secretRows(measured);
      expect(rows).toHaveLength(operation === 'delete' ? 0 : 1);
      if (stage === 'after-batch') expect(rows).toEqual(afterFailure);
      if (operation !== 'delete')
        expect(
          (await decryptRow(measured.key, rows[0])) ===
            (operation === 'create' ? input.value : replacement.value),
        ).toBe(true);
    } finally {
      await measured.close();
    }
  },
);
it('E28: two concurrent creates yield one winner and one unchanged duplicate', async () => {
  const inputs = [secretInput(), secretInput()];
  const responses = await Promise.all(
    inputs.map((input) => createSecret(app, input)),
  );
  expect(responses.map((response) => response.status).sort()).toEqual([
    201, 409,
  ]);
  const [row] = await secretRows(app);
  expect(
    (await decryptRow(app.key, row)) ===
      inputs[responses.findIndex((response) => response.status === 201)].value,
  ).toBe(true);
});
it('E28: two concurrent replacements of one version yield one winner and SecretChanged', async () => {
  const { input, path } = await original();
  const replacements = [secretInput(), secretInput()].map((next) => ({
    ...next,
    expectedVersion: input.writeId,
  }));
  const responses = await Promise.all(
    replacements.map((next) => replaceSecret(app, path, next)),
  );
  expect(responses.map((response) => response.status).sort()).toEqual([
    200, 409,
  ]);
  expect(
    await responses.find((response) => response.status === 409)!.json(),
  ).toMatchObject({ _tag: 'SecretChanged' });
  const [row] = await secretRows(app);
  expect(
    (await decryptRow(app.key, row)) ===
      replacements[responses.findIndex((response) => response.status === 200)]
        .value,
  ).toBe(true);
});
it('E28: concurrent replace/delete apply exactly one change', async () => {
  const { input, path } = await original();
  const replacement = { ...secretInput(), expectedVersion: input.writeId };
  const responses = await Promise.all([
    replaceSecret(app, path, replacement),
    deleteSecret(app, path, input.writeId),
  ]);
  expect(responses.filter((response) => response.ok)).toHaveLength(1);
  const loser = responses.find((response) => !response.ok)!;
  expect([404, 409]).toContain(loser.status);
  const rows = await secretRows(app);
  if (responses[0].ok)
    expect((await decryptRow(app.key, rows[0])) === replacement.value).toBe(
      true,
    );
  else expect(rows).toEqual([]);
});
it.each(['replace', 'delete'])(
  'E28: stale owner %s cannot destroy a deleted-and-recreated secret',
  async (operation) => {
    const { input, path } = await original();
    expect((await deleteSecret(app, path, input.writeId)).status).toBe(204);
    const replacement = secretInput();
    expect((await createSecret(app, replacement)).status).toBe(201);
    const before = await secretRows(app);
    const response =
      operation === 'replace'
        ? await replaceSecret(app, path, {
            ...secretInput(),
            expectedVersion: input.writeId,
          })
        : await deleteSecret(app, path, input.writeId);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ _tag: 'SecretChanged' });
    expect(await secretRows(app)).toEqual(before);
    expect((await decryptRow(app.key, before[0])) === replacement.value).toBe(
      true,
    );
  },
);
it('E28: create racing bucket deletion cannot leave an orphan', async () => {
  const responses = await Promise.all([
    createSecret(app, secretInput({ bucket: 'work/globex' })),
    fetch(`${app.origin}/api/buckets/work%2Fglobex`, { method: 'DELETE' }),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual(
    responses[0].ok ? [201, 409] : [204, 404],
  );
  expect(
    await responses.find((response) => !response.ok)!.json(),
  ).toMatchObject({
    message: responses[0].ok
      ? 'Delete its secrets first.'
      : 'Bucket not found.',
  });
  const orphans = await (await app.mf.getD1Database('DB'))
    .prepare(
      'SELECT name FROM secrets LEFT JOIN buckets ON secrets.bucket=buckets.path WHERE buckets.path IS NULL',
    )
    .all();
  expect(orphans.results).toEqual([]);
});
it('the Vault D1 budget is one statement or atomic batch, plus machine authentication', async () => {
  const labels: string[] = [];
  const measured = await vaultCheckpoints(async (label) => {
    labels.push(label);
    return true;
  });
  const calls = () =>
    labels.filter(
      (label) => label === '/statement' || label === '/before-batch',
    ).length;
  try {
    const input = secretInput();
    labels.length = 0;
    expect((await createSecret(measured, input)).status).toBe(201);
    expect(calls()).toBe(1);
    labels.length = 0;
    await listSecrets(measured);
    expect(calls()).toBe(1);
    labels.length = 0;
    await mcpDriver(measured.origin).call('list_secrets', {
      bucket: 'work/acme',
    });
    expect(calls()).toBe(1);
    const { token } = await issueGrant(measured, ['work/acme']);
    labels.length = 0;
    await machineMcp(measured, token).call('list_secrets', {
      bucket: 'work/acme',
    });
    expect(calls()).toBe(2);
    labels.length = 0;
    expect(
      (
        await fetch(`${measured.origin}/api/machine/secrets?bucket=work/acme`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200);
    expect(calls()).toBe(2);
    labels.length = 0;
    const replacement = { ...secretInput(), expectedVersion: input.writeId };
    expect(
      (await replaceSecret(measured, 'work/acme/STRIPE_KEY', replacement))
        .status,
    ).toBe(200);
    expect(calls()).toBe(1);
    labels.length = 0;
    expect(
      (
        await deleteSecret(
          measured,
          'work/acme/STRIPE_KEY',
          replacement.writeId,
        )
      ).status,
    ).toBe(204);
    expect(calls()).toBe(1);
    await measured.setBindings({
      LOCAL_OWNER: 'synthetic-owner',
      LOCAL_ORIGIN: measured.origin,
    });
    labels.length = 0;
    expect((await createSecret(measured, secretInput())).status).toBe(503);
    expect(calls()).toBe(0);
    expect(
      (
        await replaceSecret(measured, 'work/acme/X', {
          ...secretInput(),
          expectedVersion: randomUUID(),
        })
      ).status,
    ).toBe(503);
    expect(calls()).toBe(0);
  } finally {
    await measured.close();
  }
});
it.each(['listAll', 'create', 'replace', 'delete'])(
  'every owner operation denies a subtree principal (%s) before D1',
  async (operation) => {
    const labels: string[] = [];
    const measured = await vaultCheckpoints(
      async (label) => {
        labels.push(label);
        return true;
      },
      ['work/acme'],
    );
    try {
      labels.length = 0;
      const response =
        operation === 'listAll'
          ? await fetch(`${measured.origin}/api/secrets`)
          : operation === 'create'
            ? await createSecret(measured, secretInput({ bucket: 'personal' }))
            : operation === 'replace'
              ? await replaceSecret(measured, 'personal/X', {
                  ...secretInput(),
                  expectedVersion: randomUUID(),
                })
              : await deleteSecret(measured, 'personal/X', randomUUID());
      expect(response.status).toBe(403);
      expect(labels).toEqual([]);
    } finally {
      await measured.close();
    }
  },
);
