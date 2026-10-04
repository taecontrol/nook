import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import type { FileCoverageData } from 'istanbul-lib-coverage';
import { createInstrumenter } from 'istanbul-lib-instrument';
import { expect, it } from 'vitest';
import {
  mergeCounters,
  validateCounters,
} from '../scripts/lib/coverage-evidence.ts';
import { analyze } from '../scripts/lib/crap-analysis.ts';
import { readEvidence } from '../scripts/lib/evidence-io.ts';
import { digest, files, sourceIdentity } from '../scripts/lib/identity.ts';
import { instrument, inventory } from '../scripts/lib/instrument.ts';

function baseline(source: string) {
  const tool = createInstrumenter({
    esModules: true,
    parserPlugins: ['typescript'],
  });
  tool.instrumentSync(source, 'policy-fixture.ts');
  return tool.lastFileCoverage();
}

function execute(source: string, invocation: string) {
  const tool = createInstrumenter({ esModules: true });
  const code = tool.instrumentSync(source, 'executed-fixture.js');
  const context: { __coverage__?: Record<string, FileCoverageData> } = {};
  runInNewContext(`${code}\n${invocation}`, context);
  return context.__coverage__?.['executed-fixture.js'] as FileCoverageData;
}

it.each([
  ['if', 'if (a) return 1; return 2;', 2],
  ['conditional', 'return a ? 1 : 2;', 2],
  ['for', 'for (let i = 0; i < a; i++) {}', 2],
  ['for in', 'for (const key in a) {}', 2],
  ['for of', 'for (const value of a) {}', 2],
  ['while', 'while (a) { break; }', 2],
  ['do while', 'do {} while (a);', 2],
  ['catch', 'try { return a; } catch (error) { return 0; }', 2],
  ['and', 'return a && b;', 2],
  ['or', 'return a || b;', 2],
  ['nullish', 'return a ?? b;', 2],
  [
    'switch',
    'switch (a) { case 1: return 1; case 2: return 2; default: return 0; }',
    3,
  ],
  ['default only', 'switch (a) { default: return 0; }', 1],
  ['and assignment', 'a &&= b; return a;', 2],
  ['or assignment', 'a ||= b; return a;', 2],
  ['nullish assignment', 'a ??= b; return a;', 2],
])('classic complexity counts %s decisions', (_name, body, expected) => {
  const source = `function decisions(a, b) { ${body} }`;
  expect(analyze(source, baseline(source))[0].complexity).toBe(expected);
});

it('partial execution uses the cubic CRAP formula and excludes nested statements', () => {
  const partial =
    'function partial(a, b) { if (a) return 1; return b ? 2 : 3; }';
  const row = analyze(partial, execute(partial, 'partial(true, false);'))[0];
  expect(row).toMatchObject({ complexity: 3, covered: 2, total: 3 });
  expect(row.coverage).toBeCloseTo(2 / 3);
  expect(row.score).toBeCloseTo(10 / 3);
  const nested =
    'function outer(a) { function inner(b) { if (b) return 1; return 2; } if (a) return inner; return null; }';
  const [outer, inner] = analyze(nested, execute(nested, 'outer(false);'));
  expect(outer).toMatchObject({ complexity: 2, covered: 2, total: 3 });
  expect(outer.coverage).toBeCloseTo(2 / 3);
  expect(inner).toMatchObject({
    complexity: 2,
    covered: 0,
    total: 3,
    coverage: 0,
    score: 6,
  });
});

it('an empty function is uncovered until its function counter executes', () => {
  const source = 'function empty() {}';
  expect(analyze(source, baseline(source))[0]).toMatchObject({
    total: 0,
    coverage: 0,
    score: 2,
  });
  expect(analyze(source, execute(source, 'empty();'))[0]).toMatchObject({
    total: 0,
    coverage: 1,
    score: 1,
  });
});

it('complexity and CRAP count a function independently from its nested functions', () => {
  const source =
    'function outer(a) { if (a) return 1; function inner(b) { return b ? 1 : 2; } return inner(false); }';
  const counters = baseline(source);
  const rows = analyze(source, counters);
  expect(rows.map((row) => [row.name, row.complexity, row.score])).toEqual([
    ['outer', 2, 6],
    ['inner', 2, 6],
  ]);
  for (const id of Object.keys(counters.s)) counters.s[id] = 1;
  for (const id of Object.keys(counters.f)) counters.f[id] = 1;
  expect(analyze(source, counters).map((row) => row.score)).toEqual([2, 2]);
});

it('uncovered decisions exceed the CRAP ceiling and metadata cannot omit a function', () => {
  const source =
    'function decisions(a, b, c) { if (a) return 1; if (b) return 2; if (c) return 3; return 4; }';
  const counters = baseline(source);
  expect(analyze(source, counters)[0]).toMatchObject({
    complexity: 4,
    coverage: 0,
    score: 20,
  });
  delete counters.fnMap['0'];
  expect(() => analyze(source, counters)).toThrow(/inventory/);
});

it('coverage merges counts only with identical maps, complete counters and valid branch shapes', () => {
  const fresh = baseline('function choice(a) { return a ? 1 : 2; }');
  const observed = structuredClone(fresh);
  for (const id of Object.keys(observed.s)) observed.s[id] = 2;
  for (const id of Object.keys(observed.f)) observed.f[id] = 2;
  for (const id of Object.keys(observed.b)) observed.b[id] = [1, 1];
  const target = structuredClone(fresh);
  mergeCounters(target, observed);
  expect(Object.values(target.f)).toEqual([2]);
  expect(Object.values(target.b)).toEqual([[1, 1]]);
  mergeCounters(target, fresh);
  expect(Object.values(target.s)).toEqual(Object.values(observed.s));
  expect(Object.values(target.f)).toEqual([2]);
  expect(Object.values(target.b)).toEqual([[1, 1]]);
  mergeCounters(target, observed);
  expect(Object.values(target.s)).toEqual(
    Object.values(observed.s).map(() => 4),
  );
  expect(Object.values(target.f)).toEqual([4]);
  expect(Object.values(target.b)).toEqual([[2, 2]]);
  const badMap = structuredClone(observed);
  badMap.fnMap = {};
  expect(() => validateCounters(fresh, badMap)).toThrow(/metadata/);
  const missing = structuredClone(observed);
  missing.f = {};
  expect(() => validateCounters(fresh, missing)).toThrow(/Missing/);
  const branch = structuredClone(observed);
  branch.b['0'] = [1];
  expect(() => validateCounters(fresh, branch)).toThrow(/shape/);
  const negative = structuredClone(observed);
  negative.f['0'] = -1;
  expect(() => validateCounters(fresh, negative)).toThrow(/count/);
});

it.each([0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])(
  'coverage rejects nonnegative counts that are not safe integers: %s',
  (invalid) => {
    const fresh = baseline('function choice(a) { return a ? 1 : 2; }');
    for (const counter of ['s', 'f', 'b'] as const) {
      const observed = structuredClone(fresh);
      const id = Object.keys(observed[counter])[0];
      if (counter === 'b') observed.b[id][0] = invalid;
      else observed[counter][id] = invalid;
      expect(() => validateCounters(fresh, observed)).toThrow(/count/);
    }
  },
);

it('coverage inventories original TypeScript, omits unchanged generated primitives and hashes the exact source', async () => {
  const paths = await inventory();
  expect(paths).toContain('apps/worker/src/auth.ts');
  expect(paths).toContain('apps/web/src/identity.ts');
  expect(paths).toContain('packages/contract/src/index.ts');
  expect(paths).not.toContain('apps/web/src/components/ui/button.tsx');
  expect(paths).not.toContain('apps/web/src/components/ui/spinner.tsx');
  const observed = await instrument('apps/worker/src/auth.ts');
  expect(Object.keys(observed.baseline.fnMap).length).toBeGreaterThan(0);
  const source = await sourceIdentity();
  expect(source.files['apps/worker/src/auth.ts']).toBe(observed.hash);
  expect(source.files['migrations/0001_buckets.sql']).toBe(
    digest(await readFile('migrations/0001_buckets.sql')),
  );
  expect(source.digest).toBe(digest(JSON.stringify(source.files)));
});

it('authored inventory fails on a loosened ceiling, changed generated code or an unconfigured executable file', async () => {
  const directory = await mkdtemp(resolve('.local', 'inventory-'));
  const originalDirectory = process.cwd();
  const generated = 'export const generated = 1;';
  const config = {
    roots: ['src'],
    complexityRoots: ['src'],
    extensions: ['.ts', '.tsx'],
    generatedInventory: 'generated.json',
    maximum: 8,
  };
  try {
    await mkdir(resolve(directory, 'src'));
    await writeFile(resolve(directory, 'src/generated.ts'), generated);
    await writeFile(
      resolve(directory, 'src/authored.ts'),
      'export const authored = 1;',
    );
    await writeFile(
      resolve(directory, 'generated.json'),
      JSON.stringify({ 'src/generated.ts': digest(generated) }),
    );
    await writeFile(
      resolve(directory, 'coverage.config.json'),
      JSON.stringify(config),
    );
    // Vitest's forks isolate cwd; no live source/configuration is modified.
    process.chdir(directory);
    expect(await inventory()).toEqual(['src/authored.ts']);
    await writeFile(
      'coverage.config.json',
      JSON.stringify({ ...config, maximum: 9 }),
    );
    await expect(inventory()).rejects.toThrow(/ceilings/);
    await writeFile('coverage.config.json', JSON.stringify(config));
    await writeFile(
      'src/generated.ts',
      `${generated}\nexport const changed = 2;`,
    );
    await expect(inventory()).rejects.toThrow(/Modified generated component/);
    await writeFile('src/generated.ts', generated);
    await writeFile('src/hidden.js', 'export const hidden = 1;');
    await expect(inventory()).rejects.toThrow(/Unconfigured executable source/);
  } finally {
    process.chdir(originalDirectory);
    await rm(directory, { recursive: true, force: true });
  }
});

it('evidence reader rejects files outside its directory', async () => {
  const directory = await mkdtemp(resolve('.local', 'evidence-'));
  try {
    await writeFile(
      resolve(directory, 'manifest.json'),
      JSON.stringify({ outputs: { '../outside.json': 'hash' } }),
    );
    await expect(readEvidence(directory)).rejects.toThrow(/namespace/);
    await writeFile(
      resolve(directory, 'manifest.json'),
      JSON.stringify({ outputs: { 'node-test.json': 'hash' } }),
    );
    await writeFile(resolve(directory, 'node-test.json'), '{}');
    expect((await readEvidence(directory)).artifacts).toEqual({
      'node-test.json': '{}',
    });
    expect((await files(directory)).length).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
