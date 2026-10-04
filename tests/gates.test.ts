import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import {
  assertBudget,
  checkBundleBudget,
  initialScripts,
  measureInitialJs,
} from '../scripts/bundle-budget.ts';
import {
  validateCoverage,
  validateShards,
} from '../scripts/coverage-evidence.ts';
import { verificationStages } from '../scripts/verification-stages.ts';

it('E14: the production cold-open scripts fit the committed 200000-byte gzip ceiling', async () => {
  const budget = JSON.parse(await readFile('bundle-budget.json', 'utf8'));
  expect(budget.initialJsGzipBytes).toBeLessThanOrEqual(200_000);
  expect(budget.initialJsGzipBytes).toBeGreaterThan(0);
  const result = await checkBundleBudget({ assetDirectory: 'dist/assets' });
  expect(result.files.length).toBeGreaterThan(0);
  expect(result.gzipBytes).toBeLessThanOrEqual(budget.initialJsGzipBytes);
  expect(result.passed).toBe(true);
});

it('E14: counts every script and modulepreload once and refuses an increase to the budget', async () => {
  const html =
    '<script type="module" src="/one.js"></script><link href="/two.js" rel="modulepreload"><script src="/one.js"></script><link rel="stylesheet" href="/styles.css">';
  expect(initialScripts(html)).toEqual(['/one.js', '/two.js']);
  const directory = await mkdtemp(resolve('.local', 'bundle-'));
  const one = randomBytes(1_000),
    two = randomBytes(2_000);
  try {
    await writeFile(resolve(directory, 'index.html'), html);
    await writeFile(resolve(directory, 'one.js'), one);
    await writeFile(resolve(directory, 'two.js'), two);
    const result = await measureInitialJs(directory);
    expect(result.gzipBytes).toBe(gzipSync(one).length + gzipSync(two).length);
    expect(() => assertBudget(200_001, 200_000)).toThrow(/budget|ceiling/i);
    expect(() => assertBudget(199_001, 199_000)).toThrow(/budget|ceiling/i);
    expect(() => assertBudget(199_000, 200_000)).not.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('E14: the measured bundle fails when it exceeds a valid ceiling', async () => {
  const directory = await mkdtemp(resolve('.local', 'over-budget-'));
  try {
    await writeFile(
      resolve(directory, 'index.html'),
      '<script src="/one.js"></script>',
    );
    await writeFile(resolve(directory, 'one.js'), randomBytes(1_000));
    const budgetPath = resolve(directory, 'budget.json');
    await writeFile(budgetPath, JSON.stringify({ initialJsGzipBytes: 100 }));
    const measured = await checkBundleBudget({
      assetDirectory: directory,
      budgetPath,
    });
    expect(measured.gzipBytes).toBeGreaterThan(100);
    expect(measured.passed).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('E16: verify runs every accepted gate in order', () => {
  expect(verificationStages).toEqual([
    'verify:style',
    'verify:ui',
    'verify:types',
    'verify:complexity',
    'test:coverage',
    'verify:crap',
    'build',
    'verify:bundle',
  ]);
});

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const sourceFiles = { 'fixture.ts': hash('export const fixture = 1;') };
const source = {
  files: sourceFiles,
  digest: hash(JSON.stringify(sourceFiles)),
};
const counters = {
  path: 'fixture.ts',
  statementMap: {
    '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 25 } },
  },
  fnMap: {},
  branchMap: {},
  s: { '0': 0 },
  f: {},
  b: {},
};

function evidence() {
  const artifacts: Record<string, string> = {
    'baseline.json': JSON.stringify({
      'fixture.ts': { hash: sourceFiles['fixture.ts'], baseline: counters },
    }),
  };
  for (const seam of ['node', 'worker', 'browser']) {
    artifacts[`${seam}-fixture.json`] = JSON.stringify({
      seam,
      loaded: { 'fixture.ts': sourceFiles['fixture.ts'] },
      counters: { 'fixture.ts': { ...counters, s: { '0': 1 } } },
    });
  }
  return {
    artifacts,
    manifest: {
      schema: 1 as const,
      source,
      outputs: Object.fromEntries(
        Object.entries(artifacts).map(([name, content]) => [
          name,
          hash(content),
        ]),
      ),
    },
  };
}

it('E19: rejects missing baselines, mismatched loaded sources, invalid observation labels and partial merged shards', () => {
  const alter = (
    name: string,
    update: (value: Record<string, unknown>) => void,
  ) => {
    const input = evidence();
    const data = JSON.parse(input.artifacts[name]);
    update(data);
    input.artifacts[name] = JSON.stringify(data);
    input.manifest.outputs[name] = hash(input.artifacts[name]);
    return input;
  };
  const missing = evidence();
  delete missing.manifest.outputs['baseline.json'];
  expect(() =>
    validateCoverage(missing.manifest, missing.artifacts, source),
  ).toThrow(/baseline/);
  const stale = alter('baseline.json', (value) => {
    value['fixture.ts'] = { hash: 'stale', baseline: counters };
  });
  expect(() =>
    validateCoverage(stale.manifest, stale.artifacts, source),
  ).toThrow(/baseline source/);
  const partial = {
    ...evidence(),
    manifest: { ...evidence().manifest, shards: 2 },
  };
  expect(() =>
    validateCoverage(partial.manifest, partial.artifacts, source),
  ).toThrow(/shards/);
  const label = alter('worker-fixture.json', (value) => {
    value.seam = 'node';
  });
  expect(() =>
    validateCoverage(label.manifest, label.artifacts, source),
  ).toThrow(/label/);
  const missingImport = alter('worker-fixture.json', (value) => {
    value.loaded = {};
  });
  expect(() =>
    validateCoverage(missingImport.manifest, missingImport.artifacts, source),
  ).toThrow(/imported source/);
  const loaded = alter('worker-fixture.json', (value) => {
    value.loaded = { 'fixture.ts': 'other-source' };
  });
  expect(() =>
    validateCoverage(loaded.manifest, loaded.artifacts, source),
  ).toThrow(/module source/);
  const unknown = alter('worker-fixture.json', (value) => {
    value.loaded = { 'unknown.ts': 'hash' };
    value.counters = { 'unknown.ts': counters };
  });
  expect(() =>
    validateCoverage(unknown.manifest, unknown.artifacts, source),
  ).toThrow(/Unknown coverage source/);
});

it('E19: accepts complete coverage and fails closed on each missing execution seam', () => {
  const complete = evidence();
  expect(() =>
    validateCoverage(complete.manifest, complete.artifacts, source),
  ).not.toThrow();
  for (const seam of ['node', 'worker', 'browser']) {
    const missing = evidence();
    delete missing.artifacts[`${seam}-fixture.json`];
    delete missing.manifest.outputs[`${seam}-fixture.json`];
    expect(() =>
      validateCoverage(missing.manifest, missing.artifacts, source),
    ).toThrow(new RegExp(seam));
  }
});

it('E19: rejects unknown manifest versions and a forged file map under the current digest', () => {
  const version = evidence();
  expect(() =>
    validateCoverage(
      { ...version.manifest, schema: 2 },
      version.artifacts,
      source,
    ),
  ).toThrow(/source identity/);
  const forged = evidence();
  expect(() =>
    validateCoverage(
      {
        ...forged.manifest,
        source: { ...source, files: { 'fixture.ts': 'fabricated' } },
      },
      forged.artifacts,
      source,
    ),
  ).toThrow(/Corrupt source identity/);
});

it('E19: rejects altered artifacts and coverage tied to different source', () => {
  const altered = evidence();
  altered.artifacts['worker-fixture.json'] += ' ';
  expect(() =>
    validateCoverage(altered.manifest, altered.artifacts, source),
  ).toThrow(/artifact|corrupt/i);
  const stale = evidence();
  expect(() =>
    validateCoverage(stale.manifest, stale.artifacts, {
      ...source,
      digest: hash('other-source'),
    }),
  ).toThrow(/source|stale/i);
});

it('E19: empty files and zero counters cannot stand in for an execution seam', () => {
  for (const observation of [
    { seam: 'browser', loaded: {}, counters: {} },
    {
      seam: 'browser',
      loaded: { 'fixture.ts': sourceFiles['fixture.ts'] },
      counters: { 'fixture.ts': counters },
    },
  ]) {
    const input = evidence();
    input.artifacts['browser-fixture.json'] = JSON.stringify(observation);
    input.manifest.outputs['browser-fixture.json'] = hash(
      input.artifacts['browser-fixture.json'],
    );
    expect(() =>
      validateCoverage(input.manifest, input.artifacts, source),
    ).toThrow(/browser execution evidence/);
  }
});

it('E19: requires exactly all three shards, with distinct indexes and the same source', () => {
  const manifests = [1, 2, 3].map((index) => ({
    ...evidence().manifest,
    shard: `${index}/3`,
  }));
  expect(() => validateShards(manifests, source)).not.toThrow();
  expect(() => validateShards(manifests.slice(0, 2), source)).toThrow(/shard/i);
  expect(() =>
    validateShards([manifests[0], manifests[0], manifests[2]], source),
  ).toThrow(/shard/i);
  expect(() =>
    validateShards(
      manifests.map((manifest) => ({
        ...manifest,
        shard: manifest.shard.replace('/3', '/2'),
      })),
      source,
    ),
  ).toThrow(/shard/i);
  expect(() =>
    validateShards(
      [
        manifests[0],
        manifests[1],
        { ...manifests[2], source: { ...source, digest: hash('different') } },
      ],
      source,
    ),
  ).toThrow(/source|stale/i);
});
