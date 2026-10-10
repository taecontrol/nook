import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Browser, Page } from 'playwright';
import { expect } from 'vitest';
import { closeBrowserPage } from './buckets-browser.ts';
import { seedGrantTree } from './grants.ts';
import { type McpVersion, mcpDriver } from './mcp.ts';
import { runtime, type TestRuntime } from './runtime.ts';

export type MemoryFixture = {
  id: string;
  bucket: string;
  content: string;
  tags: string[];
  createdAt: string;
  client: { name: string; version: string | null };
  principal: { kind: 'owner' } | { kind: 'machine'; id: string; name: string };
  workingDirectory: string | null;
};
export const memoryBuckets = [
  'me',
  'personal',
  'work',
  'work/acme',
  'work/acme/api',
];
export const memoryId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const releaseContent = `# Release process

Use the workflow, never create release tags or assets by hand. Esta guía se aplica a cada publicación del CLI.

## Before the release

- Confirm \`pnpm verify\` is green on \`main\`.
- Review the changelog and the pending migration plan with Luis.
- Check that the Cloudflare deployment uses the configured account and hostname.
- Ask for a second look when a persisted contract changes.

## Release sequence

1. Pull the green main branch.
2. Run the release workflow from GitHub Actions.
3. Record the result in the deployment notes.

\`\`\`bash
pnpm verify
# ${'long-command-line-'.repeat(35)}
\`\`\`

## Después del despliegue

- Verificar la pantalla inicial y la navegación entre buckets.
- Confirmar que remember aparece para el agente autorizado.

| Check | Expected result | Owner |
| --- | --- | --- |
| Web route | First screen renders | Luis |
| Memory MCP | Bucket grant enforced | Build box |

Release page: [Nook releases](https://github.com/taecontrol/nook/releases).
An imported note contains [unsafe link](javascript:alert(1)).
Raw HTML: <img src=x onerror=alert(1)> and <script>alert(1)</script>.
Remote image: ![status](https://tracker.example/pixel.png?d=secret).

${Array.from({ length: 8 }, (_, i) => `## Readiness review ${i + 1}\n\nConfirm the release commit, the migration plan, and the owner journey. Keep installation configuration outside the source. Revisar los permisos del bucket antes de publicar.\n`).join('\n')}`;
export function memoryFixture(
  n: number,
  overrides: Partial<MemoryFixture> = {},
): MemoryFixture {
  return {
    id: memoryId(n),
    bucket: 'work/acme',
    content: `# Deployment note ${n}\n\nConfirm CI before promoting the commit.`,
    tags: ['deploy'],
    createdAt: new Date(Date.UTC(2026, 9, 9, 14, 20 - n)).toISOString(),
    client: { name: 'claude-code', version: '2.1.295' },
    principal: { kind: 'machine', id: 'synthetic-mbp', name: 'luis-mbp' },
    workingDirectory: '/Users/luis/code/acme-api',
    ...overrides,
  };
}
export const typicalMemories = [
  memoryFixture(1, {
    content: releaseContent,
    tags: ['deploy', 'release-process', 'cli'],
  }),
  memoryFixture(2, {
    content: '# Acme API deployment\n\nDeploy staging before production.',
    client: { name: 'codex-mcp-client', version: '0.162.0' },
    principal: { kind: 'machine', id: 'synthetic-build', name: 'build-box' },
    workingDirectory: '/srv/build/acme-api',
  }),
  memoryFixture(3, {
    content:
      'Customer convention: use ACME-#### in commit descriptions and keep customer-facing notes free of internal hostnames.',
    createdAt: '2026-10-08T18:10:00.000Z',
    tags: ['conventions'],
  }),
  memoryFixture(4, {
    bucket: 'work',
    content:
      '# Write commit messages in English\n\nKeep the subject in the imperative mood.',
    client: { name: 'unknown', version: null },
    principal: { kind: 'owner' },
    workingDirectory: null,
  }),
  memoryFixture(5, {
    bucket: 'work',
    content:
      'For production deploys, wait for CI and review the exact commit that will be promoted.',
    createdAt: '2026-10-07T16:30:00.000Z',
  }),
  memoryFixture(6, {
    bucket: 'me',
    content: '# Prefer pnpm\n\nUse pnpm for installs and scripts.',
  }),
  memoryFixture(7, {
    bucket: 'me',
    content:
      'Before changing an architectural invariant, read the ADRs and record the new decision.',
    tags: [],
    createdAt: '2026-10-06T10:00:00.000Z',
    principal: { kind: 'owner' },
    workingDirectory: null,
  }),
];
export const tenTags = [
  'deploy',
  'release-process',
  'migration',
  'cloudflare',
  'acme',
  'web',
  'cli',
  'review',
  'health',
  'handoff',
];
export const manyMemories = Array.from({ length: 90 }, (_, i) =>
  memoryFixture(100 + i, {
    bucket: i < 60 ? 'work/acme' : i % 2 ? 'me' : 'work',
    content: `# Review the migration before promoting the API${i % 13 === 0 ? ' — check the release workflow, migration plan, and deployment notes before promoting the selected commit' : ''}\n\nDeployment note ${i}: verify the owner journey.`,
    tags: i % 11 === 0 ? tenTags : ['deploy'],
    createdAt: new Date(Date.UTC(2026, 9, 9, 14, 20 - i)).toISOString(),
  }),
);
export async function seedMemories(app: TestRuntime, seeds = typicalMemories) {
  if (seeds.length === 0) return;
  const db = await app.mf.getD1Database('DB');
  await db.batch(
    seeds.flatMap((m) => [
      db
        .prepare(
          'INSERT INTO memories(id,bucket,current_version,content_hash,created_at,updated_at) VALUES (?,?,1,?,?,?)',
        )
        .bind(
          m.id,
          m.bucket,
          createHash('sha256').update(m.content).digest('hex'),
          m.createdAt,
          m.createdAt,
        ),
      db
        .prepare(
          'INSERT INTO memory_versions(memory_id,version,content,tags,client_name,client_version,principal,machine_id,machine_name,working_directory,created_at) VALUES (?,1,?,?,?,?,?,?,?,?,?)',
        )
        .bind(
          m.id,
          m.content,
          JSON.stringify(m.tags),
          m.client.name,
          m.client.version,
          m.principal.kind,
          m.principal.kind === 'machine' ? m.principal.id : null,
          m.principal.kind === 'machine' ? m.principal.name : null,
          m.workingDirectory,
          m.createdAt,
        ),
    ]),
  );
}
export async function memoryRuntime(
  options: Parameters<typeof runtime>[0] = {},
) {
  const app = await runtime(options);
  await app.setBindings({
    LOCAL_OWNER: 'synthetic-owner',
    LOCAL_ORIGIN: app.origin,
  });
  await seedGrantTree(app, memoryBuckets);
  return app;
}
export async function seedMemoryMachine(
  app: TestRuntime,
  grant: unknown = ['work'],
) {
  const token = `nook_${randomBytes(32).toString('base64url')}`;
  const id = randomUUID();
  await (await app.mf.getD1Database('DB'))
    .prepare(
      'INSERT INTO machine_tokens(token_hash,machine_name,grant_json,created_at,id) VALUES (?,?,?,?,?)',
    )
    .bind(
      createHash('sha256').update(token).digest('hex'),
      'luis-mbp',
      JSON.stringify(grant),
      Date.now(),
      id,
    )
    .run();
  return { token, id };
}
export function memoryClient(
  app: TestRuntime,
  version: McpVersion,
  options: {
    machine?: boolean;
    headers?: HeadersInit;
    clientInfo?: unknown;
    removeClientInfo?: boolean;
  } = {},
) {
  return mcpDriver(app.origin, version, options.headers, async (request) => {
    const url = new URL(request.url);
    if (options.machine) url.pathname = '/api/machine/mcp';
    const body = JSON.parse(await request.text());
    if (options.removeClientInfo && body.params?._meta)
      delete body.params._meta['io.modelcontextprotocol/clientInfo'];
    if (options.clientInfo !== undefined) {
      body.params ??= {};
      body.params._meta ??= {};
      body.params._meta['io.modelcontextprotocol/clientInfo'] =
        options.clientInfo;
    }
    return fetch(
      new Request(url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(body),
      }),
    );
  });
}
export async function memoryCounts(app: TestRuntime) {
  return (await (
    await app.mf.getD1Database('DB')
  )
    .prepare(
      'SELECT (SELECT count(*) FROM memories) AS memories, (SELECT count(*) FROM memory_versions) AS versions',
    )
    .first()) as { memories: number; versions: number };
}
export async function memoryPage(
  browser: Browser,
  options: {
    seeds?: MemoryFixture[];
    start?: string;
    viewport?: { width: number; height: number };
    colorScheme?: 'light' | 'dark';
    configure?: (page: Page, app: TestRuntime) => Promise<void>;
  } = {},
) {
  const app = await memoryRuntime();
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1440, height: 900 },
    colorScheme: options.colorScheme ?? 'light',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const close = async () => {
    try {
      await closeBrowserPage(page, context);
    } finally {
      await app.close();
    }
  };
  try {
    await seedMemories(app, options.seeds);
    await options.configure?.(page, app);
    await page.goto(app.origin + (options.start ?? '/memory?bucket=work/acme'));
    return { page, app, context, close };
  } catch (error) {
    await close();
    throw error;
  }
}
export const memoryRows = (page: Page) => page.locator('[data-memory-row]');
export async function listMemoryPage(
  app: TestRuntime,
  query = 'bucket=work/acme',
  headers: HeadersInit = {},
) {
  const response = await fetch(`${app.origin}/api/memories?${query}`, {
    headers,
  });
  expect(response.status, 'The owner memory read API is available').toBe(200);
  return (await response.json()) as {
    memories: {
      id: string;
      bucket: string;
      title: string;
      tags: string[];
      createdAt: string;
      provenance: unknown;
    }[];
    next: string | null;
  };
}
