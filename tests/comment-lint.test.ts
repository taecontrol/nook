import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

type Diagnostic = {
  filename: string;
  message: string;
  labels: { span: { line: number } }[];
};

function kind(message: string) {
  if (message.includes('Tighten')) return 'tighten';
  if (message.includes('no longer exist')) return 'stale';
  return 'banned';
}

async function lint(
  files: Record<string, string>,
  published: Record<string, number>,
  current = published,
) {
  const directory = await mkdtemp(resolve(tmpdir(), 'nook-comment-lint-'));
  try {
    await writeFile(
      resolve(directory, 'oxlintrc.json'),
      JSON.stringify({
        jsPlugins: [resolve('scripts/lint/no-comments.ts')],
        categories: { correctness: 'off' },
        rules: {
          'nook/no-comments': [
            'error',
            { baseline: 'baseline.json', base: 'base.json' },
          ],
        },
      }),
    );
    await writeFile(resolve(directory, 'base.json'), JSON.stringify(published));
    await writeFile(
      resolve(directory, 'baseline.json'),
      JSON.stringify(current),
    );
    for (const [name, source] of Object.entries(files))
      await writeFile(resolve(directory, name), source);
    const result = spawnSync(
      resolve('node_modules/.bin/oxlint'),
      ['-c', 'oxlintrc.json', '--format', 'json', '.'],
      { cwd: directory, encoding: 'utf8' },
    );
    const reported = JSON.parse(result.stdout)
      .diagnostics.map((diagnostic: Diagnostic) => [
        diagnostic.filename,
        diagnostic.labels[0]?.span.line,
        kind(diagnostic.message),
      ])
      .sort();
    return {
      status: result.status,
      reported,
      output: result.stdout + result.stderr,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

it('bans comments in new code and ratchets each baselined file down to its current count', async () => {
  const result = await lint(
    {
      'clean.ts': 'export const clean = 1;\n',
      'new.ts': 'export const fresh = 1;\n// added\n',
      'held.ts': '// kept\nexport const held = 1;\n',
      'grown.ts': '// kept\nexport const grown = 1; /* added */\n',
      'shrunk.ts': 'export const shrunk = 1;\n',
    },
    { 'held.ts': 1, 'grown.ts': 1, 'shrunk.ts': 1 },
  );
  expect(result.status).toBe(1);
  expect(result.reported).toEqual([
    ['grown.ts', 1, 'banned'],
    ['grown.ts', 2, 'banned'],
    ['new.ts', 2, 'banned'],
    ['shrunk.ts', 1, 'tighten'],
  ]);
});

it("allows no more than the base branch's baseline and reports entries for deleted files", async () => {
  const result = await lint(
    {
      'raised.ts': '// one\n// two\nexport const raised = 1;\n',
      'added.ts': '// one\nexport const added = 1;\n',
    },
    { 'raised.ts': 1, 'deleted.ts': 1 },
    { 'raised.ts': 2, 'added.ts': 1, 'deleted.ts': 1 },
  );
  expect(result.status).toBe(1);
  expect(
    result.reported.filter(([, , kind]: string[]) => kind !== 'stale'),
  ).toEqual([
    ['added.ts', 1, 'banned'],
    ['raised.ts', 1, 'banned'],
    ['raised.ts', 2, 'banned'],
  ]);
  expect(result.output).toContain(
    'files that no longer exist from baseline.json: deleted.ts.',
  );
});

it('fails instead of letting a disable directive hide the ban', async () => {
  const result = await lint(
    {
      'hidden.ts':
        '// oxlint-disable-next-line nook/no-comments\n// hidden\nexport const hidden = 1;\n',
    },
    { 'hidden.ts': 0 },
  );
  expect(result.status).toBe(1);
  expect(result.output).toContain('hidden.ts:1 disables lint rules');
});
