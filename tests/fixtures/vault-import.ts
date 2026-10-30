export const importBucket = 'work/acme/api';
export const mixedPaste = `# Acme API — local development
NODE_ENV=development
PORT=4000
DATABASE_URL="postgres://acme:p4ss@localhost:5432/acme_dev"
REDIS_URL=redis://localhost:6379
STRIPE_SECRET_KEY=sk_test_51NzQhR2eZvKYlo2C8h1Xq   # test mode
STRIPE_WEBHOOK_SECRET=whsec_9f8a7b6c5d4e3f2a1b0c
SENTRY_DSN=https://4f1c@o123456.ingest.sentry.io/789
export OPENAI_API_KEY=sk-proj-Qm9vbkxpZ2h0
next_public_posthog_key=phc_4kq8ZrT
AWS-REGION=us-east-1
MAILGUN_API_KEY=
JWT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASC
-----END PRIVATE KEY-----"
GITHUB_APP_ID=123456
paste the slack token here later`;

export const mixedValues: Readonly<Record<string, string>> = {
  NODE_ENV: 'development',
  PORT: '4000',
  DATABASE_URL: 'postgres://acme:p4ss@localhost:5432/acme_dev',
  REDIS_URL: 'redis://localhost:6379',
  STRIPE_SECRET_KEY: 'sk_test_51NzQhR2eZvKYlo2C8h1Xq',
  STRIPE_WEBHOOK_SECRET: 'whsec_9f8a7b6c5d4e3f2a1b0c',
  SENTRY_DSN: 'https://4f1c@o123456.ingest.sentry.io/789',
  OPENAI_API_KEY: 'sk-proj-Qm9vbkxpZ2h0',
  next_public_posthog_key: 'phc_4kq8ZrT',
  'AWS-REGION': 'us-east-1',
  MAILGUN_API_KEY: '',
  JWT_PRIVATE_KEY:
    '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----',
  GITHUB_APP_ID: '123456',
};

export const readyNames = [
  'NODE_ENV',
  'PORT',
  'DATABASE_URL',
  'REDIS_URL',
  'STRIPE_WEBHOOK_SECRET',
  'OPENAI_API_KEY',
  'JWT_PRIVATE_KEY',
  'GITHUB_APP_ID',
];
export const existingNames = ['STRIPE_SECRET_KEY', 'SENTRY_DSN'];
export const importedValues = Object.values(mixedValues).filter(Boolean);
export const importSeeds = [
  ['me', 'OPENAI_API_KEY', 'Personal key'],
  ['work/acme', 'DB_URL', ''],
  ['work/acme', 'GH_TOKEN', 'GitHub token for release PRs'],
  [importBucket, 'SENTRY_DSN', ''],
  [importBucket, 'STRIPE_SECRET_KEY', 'Stripe test mode'],
] as const;

export const keysPaste = (count: number) =>
  Array.from(
    { length: count },
    (_, index) => `KEY_${index}=synthetic-import-value-${index}`,
  ).join('\n');
