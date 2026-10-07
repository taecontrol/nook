import { createHash, randomBytes, randomUUID, webcrypto } from 'node:crypto';
import { expect } from 'vitest';
import { jsonRequest } from './authorizations.ts';
import { seedGrantTree } from './grants.ts';
import { expectPrivate } from './machines.ts';
import { runtime, type TestRuntime } from './runtime.ts';

export type SecretMetadata = {
  path: string;
  bucket: string;
  name: string;
  description: string;
  updatedAt: string;
  version: string;
};
export type SecretRow = {
  bucket: string;
  name: string;
  description: string;
  version: string;
  key_id: string;
  iv: string;
  ciphertext: string;
  created_at: string;
  updated_at: string;
};
export const vaultBuckets = [
  'me',
  'personal',
  'personal/finances',
  'work',
  'work/acme',
  'work/acme/billing-service',
  'work/globex',
];
export const vaultSeeds = [
  ['me', 'GITHUB_TOKEN', 'Personal access token for gh', '2026-09-12'],
  ['me', 'OPENAI_API_KEY', '', '2026-08-30'],
  ['work', 'NPM_TOKEN', 'Publish token for the work npm org', '2026-07-02'],
  ['work/acme', 'STRIPE_KEY', 'Stripe test-mode secret key', '2026-10-01'],
  [
    'work/acme',
    'GH_TOKEN',
    'Fine-grained token for acme repositories',
    '2026-09-28',
  ],
  [
    'work/acme',
    'DATABASE_URL',
    'Staging Postgres connection string',
    '2026-09-15',
  ],
  ['work/acme', 'SENTRY_AUTH_TOKEN', '', '2026-06-20'],
  [
    'work/acme/billing-service',
    'CLOUDFLARE_API_TOKEN_FOR_BILLING_SERVICE_PRODUCTION_DEPLOYS',
    'Scoped to the billing-service Worker and its D1 database; rotate after each quarterly audit of the deploy pipeline',
    '2026-10-06',
  ],
  [
    'personal/finances',
    'PLAID_SECRET',
    'Plaid development secret for the budget importer',
    '2026-05-11',
  ],
] as const;
export const visibleAcme = [
  'work/acme/DATABASE_URL',
  'work/acme/GH_TOKEN',
  'work/acme/SENTRY_AUTH_TOKEN',
  'work/acme/STRIPE_KEY',
  'work/NPM_TOKEN',
  'me/GITHUB_TOKEN',
  'me/OPENAI_API_KEY',
];
export function secretInput(overrides: Record<string, unknown> = {}) {
  return {
    bucket: 'work/acme',
    name: 'STRIPE_KEY',
    description: 'Stripe test-mode secret key',
    value: `synthetic-vault-${randomUUID()}`,
    writeId: randomUUID(),
    ...overrides,
  };
}
export async function vaultRuntime(
  options: Parameters<typeof runtime>[0] = {},
) {
  const key = randomBytes(32).toString('base64');
  const app = await runtime(options);
  const bindings = {
    LOCAL_OWNER: 'synthetic-owner',
    LOCAL_ORIGIN: app.origin,
    VAULT_KEY: key,
  };
  await app.setBindings(bindings);
  await seedGrantTree(app, vaultBuckets);
  return { ...app, key, bindings };
}
export function createSecret(
  app: TestRuntime,
  input = secretInput(),
  headers: Record<string, string> = {},
) {
  return jsonRequest(app, '/api/secrets', input, headers);
}
export function replaceSecret(
  app: TestRuntime,
  path: string,
  input: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return jsonRequest(
    app,
    `/api/secrets/${encodeURIComponent(path)}`,
    input,
    headers,
    'PUT',
  );
}
export function deleteSecret(
  app: TestRuntime,
  path: string,
  version: string,
  headers: Record<string, string> = {},
) {
  return fetch(
    `${app.origin}/api/secrets/${encodeURIComponent(path)}?version=${encodeURIComponent(version)}`,
    { method: 'DELETE', headers },
  );
}
export async function listSecrets(app: TestRuntime) {
  const response = await fetch(`${app.origin}/api/secrets`);
  expect(response.status, 'The owner metadata list exists').toBe(200);
  return ((await response.json()) as { secrets: SecretMetadata[] }).secrets;
}
export async function secretRows(app: TestRuntime) {
  return (
    await (
      await app.mf.getD1Database('DB')
    )
      .prepare('SELECT * FROM secrets ORDER BY bucket, name')
      .all<SecretRow>()
  ).results;
}
export function expectNoValue(text: string, values: readonly string[]) {
  expectPrivate(
    text,
    values.flatMap((value) => [
      value,
      Buffer.from(value).toString('hex'),
      Buffer.from(value).toString('base64'),
      Buffer.from(value).toString('base64url'),
    ]),
  );
}
export async function decryptRow(
  key: string,
  row: SecretRow,
  path = `${row.bucket}/${row.name}`,
) {
  const imported = await webcrypto.subtle.importKey(
    'raw',
    Buffer.from(key, 'base64'),
    'AES-GCM',
    false,
    ['decrypt'],
  );
  const bytes = await webcrypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: Buffer.from(row.iv, 'base64url'),
      additionalData: Buffer.from(path),
      tagLength: 128,
    },
    imported,
    Buffer.from(row.ciphertext, 'base64url'),
  );
  return Buffer.from(bytes).toString('utf8');
}
export function keyFingerprint(key: string) {
  return createHash('sha256')
    .update(Buffer.from(key, 'base64'))
    .digest('hex')
    .slice(0, 16);
}
export async function seedSecrets(
  app: TestRuntime,
  seeds: readonly (readonly string[])[] = vaultSeeds,
) {
  const values: string[] = [];
  for (const [bucket, name, description, date] of seeds) {
    const input = secretInput({ bucket, name, description });
    expect(
      (await createSecret(app, input)).status,
      'Representative secrets can be stored',
    ).toBe(201);
    values.push(input.value);
    if (date)
      await (await app.mf.getD1Database('DB'))
        .prepare(
          'UPDATE secrets SET created_at=?, updated_at=? WHERE bucket=? AND name=?',
        )
        .bind(`${date}T08:00:00.000Z`, `${date}T08:00:00.000Z`, bucket, name)
        .run();
  }
  return values;
}
