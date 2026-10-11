import type { FileCoverageData } from 'istanbul-lib-coverage';
import { digest, type SourceIdentity } from './identity.ts';

export type Baseline = Record<
  string,
  { hash: string; baseline: FileCoverageData }
>;
export type Manifest = {
  schema: number;
  source: SourceIdentity;
  outputs: Record<string, string>;
  shard?: string;
  shards?: number;
};
export type Observation = {
  seam: string;
  loaded: Record<string, string>;
  counters: Record<string, FileCoverageData>;
};

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

function validateCount(
  expected: number | number[],
  actual: number | number[] | undefined,
) {
  if (Array.isArray(actual) && !Array.isArray(expected))
    throw new Error('Scalar shape mismatch');
  if (
    Array.isArray(expected) &&
    (!Array.isArray(actual) || actual.length !== expected.length)
  )
    throw new Error('Branch shape mismatch');
  if (
    ![actual]
      .flat()
      .every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)
  )
    throw new Error('Invalid coverage count');
}

export function validateCounters(
  baseline: FileCoverageData,
  observed: FileCoverageData,
) {
  for (const key of ['statementMap', 'fnMap', 'branchMap'] as const) {
    if (!same(baseline[key], observed[key]))
      throw new Error(`Coverage metadata mismatch: ${key}`);
  }
  for (const key of ['s', 'f', 'b'] as const) {
    if (!same(Object.keys(baseline[key]), Object.keys(observed[key])))
      throw new Error(`Missing ${key} counters`);
    for (const [id, expected] of Object.entries(baseline[key])) {
      validateCount(expected, observed[key][id]);
    }
  }
}

export function mergeCounters(
  target: FileCoverageData,
  observed: FileCoverageData,
) {
  validateCounters(target, observed);
  for (const key of ['s', 'f'] as const) {
    for (const id of Object.keys(target[key]))
      target[key][id] += observed[key][id];
  }
  for (const id of Object.keys(target.b))
    target.b[id] = target.b[id].map(
      (count, index) => count + observed.b[id][index],
    );
}

export function validateSource(manifest: Manifest, source: SourceIdentity) {
  if (manifest.schema !== 1 || manifest.source.digest !== source.digest)
    throw new Error('Missing or stale coverage source identity');
  if (manifest.source.digest !== digest(JSON.stringify(manifest.source.files)))
    throw new Error('Corrupt source identity');
}

export function validateArtifacts(
  manifest: Manifest,
  artifacts: Record<string, string>,
  source: SourceIdentity,
) {
  validateSource(manifest, source);
  if (!manifest.outputs['baseline.json'])
    throw new Error('Undeclared coverage baseline');
  for (const [name, hash] of Object.entries(manifest.outputs)) {
    if (!/^[\w-]+\.json$/.test(name))
      throw new Error('Coverage artifact outside namespace');
    if (artifacts[name] === undefined || digest(artifacts[name]) !== hash)
      throw new Error(`Corrupt coverage artifact ${name}`);
  }
}

function mergeObservation(
  name: string,
  observation: Observation,
  baseline: Baseline,
  seen: Set<string>,
  executed: Set<string>,
) {
  if (
    !name.startsWith(`${observation.seam}-`) ||
    !['node', 'worker', 'browser', 'cli'].includes(observation.seam)
  )
    throw new Error('Execution environment label mismatch');
  if (
    !same(
      Object.keys(observation.loaded).sort(),
      Object.keys(observation.counters).sort(),
    )
  )
    throw new Error('Missing imported source coverage');
  for (const [file, counters] of Object.entries(observation.counters)) {
    if (!baseline[file]) throw new Error(`Unknown coverage source: ${file}`);
    if (observation.loaded[file] !== baseline[file].hash)
      throw new Error('Loaded module source mismatch');
    mergeCounters(baseline[file].baseline, counters);
    seen.add(file);
    if (
      [...Object.values(counters.s), ...Object.values(counters.f)].some(
        (count) => count > 0,
      )
    )
      executed.add(observation.seam);
  }
}

function requiredSeams(baseline: Baseline) {
  const required = ['node', 'worker', 'browser'];
  if (Object.keys(baseline).some((file) => file.startsWith('apps/cli/src/')))
    required.push('cli');
  return required;
}
// CI splits Linux coverage into this many shards; macOS adds one more source.
export const linuxShards = 4;
export const coverageShards = [
  ...Array.from({ length: linuxShards }, (_, i) => `${i + 1}/${linuxShards}`),
  'macos',
];
const shardsMessage = `Expected all ${linuxShards} Linux coverage shards and macOS`;
export function validateCoverage(
  manifest: Manifest,
  artifacts: Record<string, string>,
  source: SourceIdentity,
) {
  validateArtifacts(manifest, artifacts, source);
  if (
    manifest.shards !== undefined &&
    manifest.shards !== coverageShards.length
  )
    throw new Error(shardsMessage);
  const baseline = JSON.parse(artifacts['baseline.json']) as Baseline;
  for (const [file, entry] of Object.entries(baseline)) {
    if (entry.hash !== source.files[file])
      throw new Error(`Stale baseline source ${file}`);
  }
  const names = Object.keys(manifest.outputs).filter((name) =>
    /^(node|worker|browser|cli)-.+\.json$/.test(name),
  );
  const seen = new Set<string>();
  const executed = new Set<string>();
  for (const name of names)
    mergeObservation(
      name,
      JSON.parse(artifacts[name]) as Observation,
      baseline,
      seen,
      executed,
    );
  for (const seam of requiredSeams(baseline)) {
    if (!executed.has(seam))
      throw new Error(`Missing ${seam} execution evidence`);
  }
  return { baseline, seen };
}

export function validateShards(manifests: Manifest[], source: SourceIdentity) {
  if (manifests.length !== coverageShards.length)
    throw new Error(shardsMessage);
  const shards = manifests
    .map((manifest) => {
      validateSource(manifest, source);
      return manifest.shard;
    })
    .sort();
  if (!same(shards, [...coverageShards].sort()))
    throw new Error('Missing, repeated or incompatible coverage shard');
}
