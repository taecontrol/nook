import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  validateCoverage,
  validateShards,
} from '../scripts/coverage-evidence.ts';
import { verificationStages } from '../scripts/verification-stages.ts';

it('E16: verify runs every accepted gate in order', () => {
  expect(verificationStages).toEqual([
    'verify:style',
    'verify:ui',
    'verify:types',
    'verify:complexity',
    'verify:migrations',
    'test:coverage',
    'verify:crap',
    'build',
    'verify:load-time',
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

it('#33 E21: merged coverage requires four platform sources, including macOS', () => {
  const input = evidence();
  expect(() =>
    validateCoverage({ ...input.manifest, shards: 4 }, input.artifacts, source),
  ).not.toThrow();
  expect(() =>
    validateCoverage({ ...input.manifest, shards: 3 }, input.artifacts, source),
  ).toThrow(/shards/);
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

it('E19/#33 E21: requires all three Linux shards and macOS, with distinct indexes and the same source', () => {
  const manifests = [1, 2, 3, 'macos'].map((index) => ({
    ...evidence().manifest,
    shard: index === 'macos' ? 'macos' : `${index}/3`,
  }));
  expect(() => validateShards(manifests, source)).not.toThrow();
  expect(() => validateShards(manifests.slice(0, 2), source)).toThrow(/shard/i);
  expect(() =>
    validateShards(
      [manifests[0], manifests[0], manifests[2], manifests[3]],
      source,
    ),
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
        manifests[2],
        { ...manifests[3], source: { ...source, digest: hash('different') } },
      ],
      source,
    ),
  ).toThrow(/source|stale/i);
  expect(() => validateShards(manifests.slice(0, 3), source)).toThrow(/shard/i);
});
