import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { validateCoverage } from '../scripts/lib/coverage-evidence.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
it('E26: CLI inventory requires real child-process execution evidence in addition to Node, Worker, and browser seams', () => {
  const file = 'apps/cli/src/fixture.ts';
  const files = { [file]: hash('export const fixture = 1;') };
  const source = { files, digest: hash(JSON.stringify(files)) };
  const coverage = {
    path: file,
    statementMap: {
      '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 25 } },
    },
    fnMap: {},
    branchMap: {},
    s: { '0': 0 },
    f: {},
    b: {},
  };
  function evidence(includeCli: boolean, executeCli = true) {
    const artifacts: Record<string, string> = {
      'baseline.json': JSON.stringify({
        [file]: { hash: files[file], baseline: coverage },
      }),
    };
    for (const seam of [
      'node',
      'worker',
      'browser',
      ...(includeCli ? ['cli'] : []),
    ])
      artifacts[`${seam}-fixture.json`] = JSON.stringify({
        seam,
        loaded: files,
        counters: {
          [file]: {
            ...coverage,
            s: { '0': seam === 'cli' && !executeCli ? 0 : 1 },
          },
        },
      });
    return {
      artifacts,
      manifest: {
        schema: 1 as const,
        source,
        outputs: Object.fromEntries(
          Object.entries(artifacts).map(([name, text]) => [name, hash(text)]),
        ),
      },
    };
  }
  const complete = evidence(true);
  expect(() =>
    validateCoverage(complete.manifest, complete.artifacts, source),
  ).not.toThrow();
  for (const missing of [evidence(false), evidence(true, false)])
    expect(() =>
      validateCoverage(missing.manifest, missing.artifacts, source),
    ).toThrow('Missing cli execution evidence');
});
