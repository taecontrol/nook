import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Log, LogLevel } from 'miniflare';
import { beforeEach, expect, it } from 'vitest';
import { access, accessFixture } from './support/access.ts';
import { issueGrant } from './support/grants.ts';
import { expectToolError, mcpDriver } from './support/mcp.ts';
import {
  createSecret,
  decryptRow,
  deleteSecret,
  expectNoValue,
  keyFingerprint,
  listSecrets,
  replaceSecret,
  secretInput,
  secretRows,
  vaultRuntime,
} from './support/vault.ts';

let app: Awaited<ReturnType<typeof vaultRuntime>>;
beforeEach(async () => {
  app = await vaultRuntime();
  return () => app.close();
});
async function stored(input = secretInput()) {
  const response = await createSecret(app, input);
  expect(response.status).toBe(201);
  return (await response.json()) as Awaited<
    ReturnType<typeof listSecrets>
  >[number];
}
it('E1: owner responses contain only metadata and D1 stores a path-bound AES-GCM envelope', async () => {
  const input = secretInput();
  const metadata = await stored(input);
  expect(Object.keys(metadata).sort()).toEqual([
    'bucket',
    'description',
    'name',
    'path',
    'updatedAt',
    'version',
  ]);
  expect(metadata).toMatchObject({
    bucket: input.bucket,
    name: input.name,
    path: `${input.bucket}/${input.name}`,
    description: input.description,
    version: input.writeId,
  });
  expect(new Date(metadata.updatedAt).toISOString()).toBe(metadata.updatedAt);
  expect(await listSecrets(app)).toEqual([metadata]);
  const [row] = await secretRows(app);
  expectNoValue(JSON.stringify({ metadata, row }), [input.value]);
  expect(Buffer.from(row.iv, 'base64url')).toHaveLength(12);
  expect(row.key_id).toBe(keyFingerprint(app.key));
  expect((await decryptRow(app.key, row)) === input.value).toBe(true);
});
it('E2: equal values have fresh IVs and ciphertext cannot be swapped between paths', async () => {
  const input = secretInput();
  await stored(input);
  await stored(secretInput({ value: input.value, name: 'OTHER_KEY' }));
  const rows = await secretRows(app);
  expect(rows[0].iv === rows[1].iv).toBe(false);
  expect(rows[0].ciphertext === rows[1].ciphertext).toBe(false);
  await expect(
    decryptRow(app.key, rows[0], 'work/acme/STRIPE_KEY'),
  ).rejects.toThrow();
});
it.each(['multi-line', '64-KiB'])(
  'E3: %s values round-trip byte for byte',
  async (kind) => {
    const value =
      kind === 'multi-line'
        ? `synthetic\n秘密 🔐\r\ntrailing  \t\n`
        : '界'.repeat(21845) + 'x';
    await stored(secretInput({ value }));
    const [row] = await secretRows(app);
    expect((await decryptRow(app.key, row)) === value).toBe(true);
  },
);
it.each(['', 'x'.repeat(65537), 'synthetic\u0000value', 'synthetic\ud800'])(
  'E3: invalid UTF-8 or size stores nothing (%#)',
  async (value) => {
    expect((await createSecret(app, secretInput({ value }))).status).toBe(400);
    expect(await secretRows(app)).toEqual([]);
  },
);
it.each(['resend_api_key', '1KEY', 'A-B', 'A'.repeat(65)])(
  'E4: an invalid name has shared validation feedback (%#)',
  async (name) => {
    const response = await createSecret(app, secretInput({ name }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      _tag: 'InvalidSecret',
      message:
        name.length > 64
          ? 'A name can have at most 64 characters.'
          : 'Use uppercase letters, digits, and underscores, starting with a letter or underscore.',
    });
    expect(await secretRows(app)).toEqual([]);
  },
);
it.each([
  '🔐'.repeat(201),
  'bad\rline',
  'bad\nline',
  'bad\u2028line',
  'bad\u2029line',
])(
  'E4: long or multi-line descriptions store nothing (%#)',
  async (description) => {
    expect((await createSecret(app, secretInput({ description }))).status).toBe(
      400,
    );
    expect(await secretRows(app)).toEqual([]);
  },
);
it('E4: the description limit counts code points', async () => {
  const description = '🔐'.repeat(200);
  expect((await stored(secretInput({ description }))).description).toBe(
    description,
  );
});
it('E5: a duplicate preserves every stored byte while the same name in an ancestor succeeds', async () => {
  await stored();
  const before = await secretRows(app);
  const duplicate = await createSecret(app);
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toEqual({
    _tag: 'SecretExists',
    message: 'work/acme/STRIPE_KEY already exists.',
  });
  expect(await secretRows(app)).toEqual(before);
  await stored(secretInput({ bucket: 'work' }));
});
it('E6: create does not create a missing bucket', async () => {
  const response = await createSecret(
    app,
    secretInput({ bucket: 'work/nowhere' }),
  );
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    _tag: 'BucketNotFound',
    message: 'Bucket not found.',
  });
  expect(await secretRows(app)).toEqual([]);
  expect(
    await (await app.mf.getD1Database('DB'))
      .prepare("SELECT path FROM buckets WHERE path='work/nowhere'")
      .first(),
  ).toBeNull();
});
it('E7: replace advances timestamp even on ties, description, version and the encrypted value', async () => {
  const original = await stored();
  const db = await app.mf.getD1Database('DB');
  const future = '2099-01-01T00:00:00.000Z';
  await db.prepare('UPDATE secrets SET updated_at=?').bind(future).run();
  const [before] = await secretRows(app);
  const input = secretInput({ description: 'Replacement description' });
  const response = await replaceSecret(app, original.path, {
    ...input,
    expectedVersion: original.version,
  });
  expect(response.status).toBe(200);
  const metadata = await response.json();
  expect(metadata).toMatchObject({
    description: input.description,
    version: input.writeId,
    updatedAt: '2099-01-01T00:00:00.001Z',
  });
  const [after] = await secretRows(app);
  expect(after.iv === before.iv).toBe(false);
  expect(after.ciphertext === before.ciphertext).toBe(false);
  expect((await decryptRow(app.key, after)) === input.value).toBe(true);
});
it.each(['replace', 'delete'])(
  'E7: %s of a missing secret returns SecretNotFound',
  async (operation) => {
    const response =
      operation === 'replace'
        ? await replaceSecret(app, 'work/nowhere/MISSING', {
            ...secretInput(),
            expectedVersion: randomUUID(),
          })
        : await deleteSecret(app, 'work/nowhere/MISSING', randomUUID());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      _tag: 'SecretNotFound',
      message: 'Secret not found.',
    });
  },
);
it.each(['replace', 'delete'])(
  'E7a: stale %s preserves the row',
  async (operation) => {
    const original = await stored();
    const before = await secretRows(app);
    const response =
      operation === 'replace'
        ? await replaceSecret(app, original.path, {
            ...secretInput(),
            expectedVersion: randomUUID(),
          })
        : await deleteSecret(app, original.path, randomUUID());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      _tag: 'SecretChanged',
      message:
        'work/acme/STRIPE_KEY changed in another session. Review it and try again.',
    });
    expect(await secretRows(app)).toEqual(before);
  },
);
it('E8: deleting a secret leaves unrelated rows byte-identical', async () => {
  const target = await stored(secretInput({ name: 'DATABASE_URL' }));
  await stored();
  const before = (await secretRows(app)).filter(
    (row) => row.name !== 'DATABASE_URL',
  );
  expect((await deleteSecret(app, target.path, target.version)).status).toBe(
    204,
  );
  expect(await secretRows(app)).toEqual(before);
});
it.each([undefined, 'malformed', Buffer.alloc(31).toString('base64')])(
  'E9: missing or malformed VAULT_KEY blocks writes but permits list and delete (%#)',
  async (key) => {
    const target = await stored();
    const before = await secretRows(app);
    await app.setBindings({
      LOCAL_OWNER: 'synthetic-owner',
      LOCAL_ORIGIN: app.origin,
      ...(key ? { VAULT_KEY: key } : {}),
    });
    for (const response of [
      await createSecret(app, secretInput({ name: 'OTHER_KEY' })),
      await replaceSecret(app, target.path, {
        ...secretInput(),
        expectedVersion: target.version,
      }),
    ]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        _tag: 'VaultNotConfigured',
      });
    }
    expect(await secretRows(app)).toEqual(before);
    expect(await listSecrets(app)).toEqual([target]);
    expect((await deleteSecret(app, target.path, target.version)).status).toBe(
      204,
    );
  },
);
it('E10: API and MCP delete refuse secrets atomically and preserve child-bucket precedence', async () => {
  const target = await stored(secretInput({ bucket: 'work/globex' }));
  const remove = (path: string) =>
    fetch(`${app.origin}/api/buckets/${encodeURIComponent(path)}`, {
      method: 'DELETE',
    });
  expect((await remove('work/globex')).status).toBe(409);
  expect(await (await remove('work/globex')).json()).toEqual({
    _tag: 'BucketHasSecrets',
    message: 'Delete its secrets first.',
  });
  const driver = mcpDriver(app.origin);
  expectToolError(
    await driver.call('delete_bucket', { path: 'work/globex' }),
    'Delete its secrets first.',
  );
  await stored();
  expectToolError(
    await driver.call('delete_bucket', { path: 'work/acme' }),
    'Delete its child buckets first.',
  );
  expect((await deleteSecret(app, target.path, target.version)).status).toBe(
    204,
  );
  expect((await remove('work/globex')).status).toBe(204);
});
it('E11: Nook Bearers authenticate no owner route and the machine API exposes no writes', async () => {
  const { token } = await issueGrant(app, ['work/acme']);
  await app.setBindings({ VAULT_KEY: app.key });
  const headers = { Authorization: `Bearer ${token}` };
  for (const [method, path] of [
    ['GET', '/api/secrets'],
    ['POST', '/api/secrets'],
    ['PUT', '/api/secrets/work%2Facme%2FSTRIPE_KEY'],
    ['DELETE', '/api/secrets/work%2Facme%2FSTRIPE_KEY?version=x'],
  ]) {
    expect(
      (await fetch(`${app.origin}${path}`, { method, headers })).status,
    ).toBe(401);
  }
  for (const [method, path] of [
    ['POST', '/api/machine/secrets'],
    ['PUT', '/api/machine/secrets/work%2Facme%2FSTRIPE_KEY'],
    ['DELETE', '/api/machine/secrets/work%2Facme%2FSTRIPE_KEY'],
  ]) {
    expect(
      (await fetch(`${app.origin}${path}`, { method, headers })).status,
    ).toBe(404);
  }
});
it('E11: foreign Origin rejects every owner write, including PUT', async () => {
  const original = await stored();
  const before = await secretRows(app);
  const issuer = await accessFixture();
  await app.setBindings(
    { ...access, VAULT_KEY: app.key },
    { outboundService: issuer.outboundService },
  );
  const headers = {
    Origin: 'https://foreign.nook.test',
    'Cf-Access-Jwt-Assertion': await issuer.assertion(),
  };
  for (const response of [
    await createSecret(app, secretInput(), headers),
    await replaceSecret(
      app,
      original.path,
      { ...secretInput(), expectedVersion: original.version },
      headers,
    ),
    await deleteSecret(app, original.path, original.version, headers),
  ])
    expect(response.status).toBe(403);
  expect(await secretRows(app)).toEqual(before);
});
class PrivateLog extends Log {
  messages: string[] = [];
  constructor() {
    super(LogLevel.VERBOSE);
  }
  protected log(message: string) {
    this.messages.push(message);
  }
}
it('E26: validation, D1 insert/replace failures and MCP errors never log values or ciphertext', async () => {
  const log = new PrivateLog();
  await app.setBindings(app.bindings, {
    log,
    handleRuntimeStdio: (stdout, stderr) => {
      for (const input of [stdout, stderr])
        createInterface({ input }).on('line', (line) =>
          log.messages.push(line),
        );
    },
  });
  const input = secretInput();
  const target = await stored(input);
  const [row] = await secretRows(app);
  const privateValues = [input.value, row.ciphertext];
  const invalid = await createSecret(
    app,
    secretInput({ value: input.value, writeId: 'invalid' }),
  );
  expect(invalid.status).toBe(400);
  expectNoValue(await invalid.text(), privateValues);
  const db = await app.mf.getD1Database('DB');
  for (const operation of ['INSERT', 'UPDATE']) {
    await db
      .prepare(
        `CREATE TRIGGER fail_${operation} BEFORE ${operation} ON secrets BEGIN SELECT RAISE(ABORT, '${input.value} ${row.ciphertext}'); END`,
      )
      .run();
  }
  for (const response of [
    await createSecret(
      app,
      secretInput({ value: input.value, name: 'OTHER_KEY' }),
    ),
    await replaceSecret(app, target.path, {
      ...input,
      writeId: randomUUID(),
      expectedVersion: target.version,
    }),
  ]) {
    expect(response.status).toBe(503);
    expectNoValue(await response.text(), privateValues);
  }
  const driver = mcpDriver(app.origin);
  expectNoValue(
    JSON.stringify(
      await driver.call('list_secrets', {
        bucket: 'work/acme',
        value: input.value,
      }),
    ),
    privateValues,
  );
  await db.prepare('DROP TABLE secrets').run();
  expectToolError(
    await driver.call('list_secrets', { bucket: 'work/acme' }),
    'Service unavailable. Try again later.',
  );
  expectNoValue(log.messages.join('\n'), privateValues);
});
it('owner secret routes validate genuine Access and reject a foreign owner', async () => {
  const issuer = await accessFixture();
  await app.setBindings(
    { ...access, VAULT_KEY: app.key },
    { outboundService: issuer.outboundService },
  );
  const other = {
    'Cf-Access-Jwt-Assertion': await issuer.assertion({
      email: 'other@nook.test',
    }),
  };
  expect((await createSecret(app, secretInput(), other)).status).toBe(403);
  const owner = { 'Cf-Access-Jwt-Assertion': await issuer.assertion() };
  expect((await createSecret(app, secretInput(), owner)).status).toBe(201);
});
