import { vaultSeeds } from './vault.ts';

const long = (text: string) => text;
const extra: [string, string | null][] = [
  ['AWS_ACCESS_KEY_ID', 'IAM user for the staging deploy role'],
  [
    'AWS_SECRET_ACCESS_KEY',
    'Pairs with AWS_ACCESS_KEY_ID for the staging deploy role',
  ],
  ['TWILIO_AUTH_TOKEN', null],
  [
    'SENDGRID_API_KEY',
    'Legacy email provider, kept until the migration to Resend finishes',
  ],
  [
    'ALGOLIA_ADMIN_API_KEY_FOR_PRODUCT_SEARCH_INDEX_REBUILDS',
    long(
      'Admin key used only by the nightly job that rebuilds the product search index from the catalog database; it can delete indices, so never use it from the storefront, a preview, or from any browser code',
    ),
  ],
  ['DATADOG_API_KEY', 'Agent and log shipping for staging hosts'],
  ['DATADOG_APPLICATION_KEY_FOR_DASHBOARD_EXPORTS', null],
  ['SLACK_BOT_TOKEN', 'Posts deploy notices to #acme-releases'],
  ['SLACK_SIGNING_SECRET', 'Verifies slash-command requests from Slack'],
  ['LINEAR_API_KEY', 'Creates issues from failed nightly builds'],
  ['POSTHOG_PERSONAL_API_KEY', null],
  ['GOOGLE_OAUTH_CLIENT_SECRET', 'Sign in with Google for the staging admin'],
  [
    'GCP_SERVICE_ACCOUNT_JSON_FOR_BIGQUERY_ANALYTICS_EXPORT_PIPELINE',
    long(
      'Service account key file (JSON) for the analytics export that copies the events tables into BigQuery every hour; the account only has dataEditor on the acme_analytics dataset and nothing else',
    ),
  ],
  ['REDIS_URL', 'Primary cache, staging cluster'],
  [
    'REDIS_URL_FOR_RATE_LIMITER_IN_THE_EU_WEST_REGION_READ_REPLICA',
    'Read replica pool used by the API rate limiter in eu-west',
  ],
  ['MAPBOX_ACCESS_TOKEN', 'Store locator maps'],
  ['OPENSEARCH_MASTER_PASSWORD', null],
  ['JWT_SIGNING_KEY', 'RS256 private key in PEM format for staging sessions'],
  ['WEBHOOK_SIGNING_SECRET_FOR_PARTNER_INTEGRATIONS', null],
  ['HUBSPOT_PRIVATE_APP_TOKEN', 'Syncs signups into the CRM'],
  ['INTERCOM_ACCESS_TOKEN', null],
  [
    'SUPABASE_SERVICE_ROLE_KEY',
    long(
      'Bypasses row-level security for the support tooling backend; only the internal admin service should read it, and any use from a machine outside the acme bucket should be treated as an incident',
    ),
  ],
  ['VERCEL_TOKEN', 'Preview deployments for the marketing site'],
  ['DOCKER_HUB_ACCESS_TOKEN', 'Pulls private base images in CI'],
  ['CIRCLECI_PERSONAL_API_TOKEN', null],
  ['SNOWFLAKE_PRIVATE_KEY_PASSPHRASE', 'Unlocks the key-pair auth private key'],
  ['PAGERDUTY_INTEGRATION_KEY', 'Events API v2 routing key for staging alerts'],
  ['AUTH0_CLIENT_SECRET', null],
  ['CONTENTFUL_MANAGEMENT_TOKEN', 'Content migrations only'],
  [
    'SHOPIFY_ADMIN_API_ACCESS_TOKEN_FOR_THE_ACME_STOREFRONT_SYNC_JOB',
    long(
      'Custom app token with read_products and write_inventory scopes; the storefront sync job runs every fifteen minutes and fails loudly if this token is revoked, which pages whoever is on call',
    ),
  ],
  ['MAILCHIMP_API_KEY', null],
  ['GITHUB_APP_PRIVATE_KEY', 'PEM key for the acme-bot GitHub App'],
  ['GITHUB_APP_WEBHOOK_SECRET', 'Verifies webhook deliveries to acme-bot'],
  ['ZENDESK_API_TOKEN', null],
  ['SEGMENT_WRITE_KEY', 'Server-side event tracking'],
  ['CLOUDINARY_API_SECRET', 'Image uploads from the admin'],
  [
    'ENCRYPTION_KEY_FOR_CUSTOMER_EXPORT_ARCHIVES_STORED_IN_R2_BUCKETS',
    long(
      'AES-256 key that encrypts customer data export archives before they are written to R2; losing it makes every existing archive unreadable, so replace it only together with a full re-export',
    ),
  ],
  ['FIGMA_PERSONAL_ACCESS_TOKEN', 'Design token export in CI'],
  ['NOTION_INTEGRATION_TOKEN', null],
  ['_INTERNAL_HEALTHCHECK_TOKEN', 'Shared by the uptime checks'],
];

const days = [
  '2026-09-30',
  '2026-09-22',
  '2026-08-14',
  '2026-07-29',
  '2026-06-03',
  '2026-05-18',
  '2026-04-27',
  '2026-03-09',
];

export const manyVaultSeeds = [
  ...vaultSeeds,
  ...extra.map(([name, description], index) => [
    'work/acme',
    name,
    description ?? '',
    days[index % days.length],
  ]),
];
