// Shared, fixed product truth for the memory-history prototype. Do not edit per candidate.
// Versions are listed oldest first here; the stub serves them newest first.
type Principal =
  | { kind: 'owner' }
  | { kind: 'machine'; id: string; name: string };
type Client = { name: string; version: string | null };
type Author = {
  principal: Principal;
  client: Client;
  workingDirectory: string | null;
};
export type FixtureVersion = {
  content: string;
  tags: string[];
  author: Author;
  minutesAgo: number;
};
export type FixtureMemory = {
  id: string;
  bucket: string;
  versions: FixtureVersion[];
};

const MIN = 1;
const HOUR = 60;
const DAY = 24 * HOUR;
const laptop: Author = {
  principal: { kind: 'machine', id: 'm-1', name: 'luis-macbook-pro' },
  client: { name: 'claude-code', version: '2.1.295' },
  workingDirectory: '/Users/luis/code/acme-api',
};
const ci: Author = {
  principal: { kind: 'machine', id: 'm-2', name: 'build-runner-02' },
  client: { name: 'codex-mcp-client', version: '0.162.0' },
  workingDirectory: '/home/runner/work/acme-api/acme-api',
};
const owner: Author = {
  principal: { kind: 'owner' },
  client: { name: 'claude-ai', version: null },
  workingDirectory: null,
};
const desktop: Author = {
  principal: { kind: 'machine', id: 'm-3', name: 'omarchy-desktop' },
  client: { name: 'codex-mcp-client', version: '0.162.0' },
  workingDirectory: '/home/luis/Work/acme/infrastructure',
};
const longMachine: Author = {
  principal: {
    kind: 'machine',
    id: 'm-4',
    name: 'luis-guette-work-laptop-2026-loaner-from-acme-it-department',
  },
  client: { name: 'unknown', version: null },
  workingDirectory:
    '/Users/luis/code/clients/acme-corporation/platform/services/payments-reconciliation-service/packages/ledger-importer',
};

const release1 = `# Release process

Deploys go out from \`main\` through the GitHub Actions \`deploy\` workflow.

1. Merge the release PR after CI is green.
2. Tag the merge commit as \`vYYYY.MM.DD\`.
3. The workflow deploys to staging, waits for smoke tests, then promotes to production.

Do not deploy on Fridays after 14:00 Bogotá time.`;
const release2 = `# Release process

Deploys go out from \`main\` through the GitHub Actions \`deploy\` workflow.

1. Merge the release PR after CI is green.
2. Tag the merge commit as \`vYYYY.MM.DD\`.
3. The workflow deploys to staging and runs \`pnpm test:smoke\` against https://staging.acme.dev.
4. Promote to production with \`gh workflow run promote.yml\`; promotion is manual since the October incident.

Do not deploy on Fridays after 14:00 Bogotá time.`;
const release4 = `# Release process

Deploys go out from \`main\` through the GitHub Actions \`deploy\` workflow.

1. Merge the release PR after CI is green.
2. Tag the merge commit as \`vYYYY.MM.DD\`.
3. The workflow deploys to staging and runs \`pnpm test:smoke\` against https://staging.acme.dev.
4. Promote to production with \`gh workflow run promote.yml\`; promotion is manual since the October incident.

Code freeze: no production deploys from Dec 18 to Jan 6. Outside the freeze, do not deploy on Fridays after 14:00 Bogotá time.`;

function rotation(week: number) {
  const people = ['Ana', 'Bruno', 'Camila', 'Diego', 'Elena'];
  const primary = people[week % people.length];
  const secondary = people[(week + 2) % people.length];
  return `# On-call rotation

This week's primary on-call is ${primary}; secondary is ${secondary}.

Page through Opsgenie schedule \`acme-api-primary\`. Escalate to the secondary after 15 minutes without acknowledgement.`;
}

function longDoc(revision: number) {
  const sections = Array.from({ length: 40 }, (_, i) => {
    const n = i + 1;
    const changed = revision > 1 && n % 7 === 0;
    const added = revision > 2 && n % 11 === 0;
    return `## Step ${n}: ${changed ? 'Reconcile settlement batch with the bank statement export' : 'Import ledger rows from the nightly settlement file'}

Run \`ledger-importer --batch=${n} --source=s3://acme-settlements/${2026}/batch-${n}.csv${changed ? ' --strict-currency' : ''}\`. Rows whose amount_minor and currency do not match the bank export are written to \`reconciliation_exceptions\` with reason \`${changed ? 'currency_mismatch' : 'amount_mismatch'}\`.${added ? '\n\nSince the Q4 audit, exceptions older than 48 hours page the finance on-call.' : ''}`;
  });
  return `# Payments reconciliation runbook\n\n${sections.join('\n\n')}`;
}

export const memories: FixtureMemory[] = [
  {
    id: '3f6c1a8e-2b4d-4e9f-9a1c-7d5e8b2f0a11',
    bucket: 'work/acme',
    versions: [
      {
        content: release1,
        tags: ['deploy'],
        author: laptop,
        minutesAgo: 12 * DAY,
      },
      {
        content: release2,
        tags: ['deploy'],
        author: ci,
        minutesAgo: 9 * DAY + 3 * HOUR,
      },
      {
        content: release2,
        tags: ['deploy', 'staging'],
        author: owner,
        minutesAgo: 5 * DAY + 20 * MIN,
      },
      {
        content: release4,
        tags: ['deploy', 'staging', 'freeze'],
        author: laptop,
        minutesAgo: 2 * HOUR + 7 * MIN,
      },
    ],
  },
  {
    id: '8a2e4c6b-1d3f-4a5b-8c7d-9e0f1a2b3c44',
    bucket: 'work/acme',
    versions: [
      {
        content: `# Package manager\n\nThe Acme API uses pnpm 12 with a frozen lockfile in CI. Never commit a package-lock.json.`,
        tags: ['tooling'],
        author: desktop,
        minutesAgo: 20 * DAY,
      },
    ],
  },
  {
    id: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e55',
    bucket: 'work/acme',
    versions: Array.from({ length: 30 }, (_, i) => ({
      content: rotation(i),
      tags: ['on-call'],
      author: i % 9 === 4 ? owner : i % 2 ? ci : laptop,
      minutesAgo: (30 - i) * 7 * DAY - 9 * HOUR,
    })),
  },
  {
    id: 'd4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f66',
    bucket:
      'work/acme/payments-reconciliation-ledgers/settlement-imports-nightly/bank-statement-exports/currency-mismatch-handling',
    versions: [
      {
        content: longDoc(1),
        tags: [
          'runbook',
          'payments',
          'reconciliation',
          'finance',
          'ledger',
          'nightly-batch',
          'opsgenie',
          'q4-audit',
          'bank-export',
          'currency',
        ],
        author: longMachine,
        minutesAgo: 40 * DAY,
      },
      {
        content: longDoc(2),
        tags: [
          'runbook',
          'payments',
          'reconciliation',
          'finance',
          'ledger',
          'nightly-batch',
          'opsgenie',
          'q4-audit',
          'bank-export',
          'currency',
        ],
        author: longMachine,
        minutesAgo: 18 * DAY,
      },
      {
        content: longDoc(3),
        tags: [
          'runbook',
          'payments',
          'reconciliation',
          'finance',
          'ledger',
          'nightly-batch',
          'opsgenie',
          'q4-audit',
          'bank-export',
          'currency',
        ],
        author: desktop,
        minutesAgo: 3 * DAY,
      },
    ],
  },
  {
    id: 'e7f8a9b0-c1d2-4e3f-8a4b-5c6d7e8f9a77',
    bucket: 'work',
    versions: [
      {
        content: `# Reportes de gastos\n\nLos gastos de viaje se reportan en Expensify antes del día 5 de cada mes, con la factura electrónica adjunta.`,
        tags: ['finanzas'],
        author: owner,
        minutesAgo: 60 * DAY,
      },
      {
        content: `# Reportes de gastos\n\nLos gastos de viaje se reportan en Expensify antes del día 3 de cada mes, con la factura electrónica adjunta y el centro de costo del cliente.`,
        tags: ['finanzas'],
        author: desktop,
        minutesAgo: 6 * DAY,
      },
    ],
  },
];

export const buckets = [
  'me',
  'work',
  'work/acme',
  'work/acme/payments-reconciliation-ledgers',
  'work/acme/payments-reconciliation-ledgers/settlement-imports-nightly',
  'work/acme/payments-reconciliation-ledgers/settlement-imports-nightly/bank-statement-exports',
  'work/acme/payments-reconciliation-ledgers/settlement-imports-nightly/bank-statement-exports/currency-mismatch-handling',
  'personal',
];

// Each scenario: a starting URL and how the history request behaves.
export const scenarios = {
  typical: {
    label: 'Typical (4 versions, tags-only change)',
    start:
      '/memory?bucket=work/acme&memory=3f6c1a8e-2b4d-4e9f-9a1c-7d5e8b2f0a11',
    history: 'ok',
  },
  'never-updated': {
    label: 'Never updated (1 version)',
    start:
      '/memory?bucket=work/acme&memory=8a2e4c6b-1d3f-4a5b-8c7d-9e0f1a2b3c44',
    history: 'ok',
  },
  many: {
    label: 'Many versions (30)',
    start:
      '/memory?bucket=work/acme&memory=c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e55',
    history: 'ok',
  },
  long: {
    label: 'Long content, names and paths',
    start:
      '/memory?bucket=work/acme/payments-reconciliation-ledgers/settlement-imports-nightly/bank-statement-exports/currency-mismatch-handling&memory=d4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f66',
    history: 'ok',
  },
  inherited: {
    label: 'Inherited memory (from work)',
    start:
      '/memory?bucket=work/acme&memory=e7f8a9b0-c1d2-4e3f-8a4b-5c6d7e8f9a77',
    history: 'ok',
  },
  'history-loading': {
    label: 'History loading',
    start:
      '/memory?bucket=work/acme&memory=3f6c1a8e-2b4d-4e9f-9a1c-7d5e8b2f0a11',
    history: 'pending',
  },
  'history-error': {
    label: 'History failed to load',
    start:
      '/memory?bucket=work/acme&memory=3f6c1a8e-2b4d-4e9f-9a1c-7d5e8b2f0a11',
    history: 'error',
  },
} as const;
export type ScenarioName = keyof typeof scenarios;
