import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  assertLoadTimes,
  formatMeasurements,
  initialScripts,
  loadTimeBudgets,
  type Measurements,
  measureInitialJs,
  median,
} from '../scripts/lib/load-time.ts';

// Every measured screen, the label its failure names, and its fixed budget.
const screens = [
  ['home', 'Cold open /', 1000],
  ['buckets', 'Cold open /buckets', 1000],
  ['authorize', 'Cold open /cli/authorize', 1000],
  ['machines', 'Cold open /machines', 1000],
  ['vault', 'Cold open /vault', 1000],
  ['audit', 'Cold open /audit', 1000],
  ['memory', 'Cold open /memory', 1000],
  ['navigation', 'Intent navigation', 100],
  ['machinesNavigation', 'Intent navigation /machines', 100],
  ['vaultNavigation', 'Intent navigation /vault', 100],
  ['auditNavigation', 'Intent navigation /audit', 100],
  ['memoryNavigation', 'Intent navigation /memory', 100],
  ['approvalNavigation', 'Loaded approval tree', 100],
] as const;
type Screen = (typeof screens)[number][0];
// Measurements requires every screen, so a new one fails type checking here.
const measurements = (
  samples: (budget: number, index: number) => number[],
): Measurements =>
  Object.fromEntries(
    screens.map(([key, , budget], index) => [key, samples(budget, index)]),
  ) as Record<Screen, number[]>;
const atLimit = measurements((budget) => Array(5).fill(budget));

it('E18/E19: cold-open and intent navigation budgets use the median of five samples', () => {
  expect(() =>
    assertLoadTimes({
      ...atLimit,
      home: [9000, 1000, 999, 700, 1001],
      buckets: [0, 0, 1001, 0, 0],
    }),
  ).not.toThrow();
});
it('E18/E19: the accepted profile and fixed budgets cannot change silently', () => {
  expect(loadTimeBudgets).toEqual({
    runs: 5,
    coldOpenMs: 1000,
    navigationMs: 100,
    network: {
      offline: false,
      downloadThroughput: 1_125_000,
      uploadThroughput: 375_000,
      latency: 85,
    },
  });
});
it.each([
  [],
  [1, 2, 3, 4],
  [1, 2, 3, 4, 5, 6],
  [1, 2, Number.NaN, 4, 5],
  [1, 2, Number.POSITIVE_INFINITY, 4, 5],
  [1, 2, -1, 4, 5],
])(
  'timing input %j requires five finite non-negative samples',
  (...samples) => {
    expect(() => median(samples)).toThrow(
      'Expected five finite non-negative timing samples.',
    );
  },
);
it('every screen accepts its exact budget and prints its own median', () => {
  expect(() => assertLoadTimes(atLimit)).not.toThrow();
  const distinct = measurements((budget, index) => [
    budget,
    0,
    budget - 1 - index,
    budget,
    0,
  ]);
  expect(JSON.parse(formatMeasurements(distinct)).medianMs).toEqual(
    Object.fromEntries(
      screens.map(([key, , budget], index) => [key, budget - 1 - index]),
    ),
  );
});
it.each(screens)(
  'an over-budget %s median fails for its own timing',
  (key, label, budget) => {
    // Two fast samples must not hide an over-budget median.
    const over = [0, budget + 1, 0, budget + 1, budget + 1];
    expect(() => assertLoadTimes({ ...atLimit, [key]: over })).toThrow(
      `${label} median ${(budget + 1).toFixed(1)} ms exceeds ${budget} ms.`,
    );
  },
);
it.each(screens)('missing %s samples cannot skip its budget', (key) => {
  expect(() => assertLoadTimes({ ...atLimit, [key]: [] })).toThrow(
    'Expected five finite non-negative timing samples.',
  );
});
it('E20: gzip bytes are printed as diagnostics and never used as a budget', () => {
  const measured = { ...atLimit, gzipBytes: 900_000 };
  expect(() => assertLoadTimes(measured)).not.toThrow();
  expect(JSON.parse(formatMeasurements(measured))).toMatchObject({
    medianMs: { home: 1000, buckets: 1000, navigation: 100 },
    coldOpenGzipBytes: 900_000,
  });
});

it('E20: diagnostics count distinct document scripts and modulepreloads using Node gzip', async () => {
  const html =
    '<script src="/one.js"></script><link href="/two.js" rel="modulepreload"><script src="/one.js"></script><link rel="stylesheet" href="/styles.css">';
  expect(initialScripts(html)).toEqual(['/one.js', '/two.js']);
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { gzipSync } = await import('node:zlib');
  const directory = await mkdtemp(resolve('.local', 'gzip-diagnostic-'));
  try {
    await writeFile(resolve(directory, 'index.html'), html);
    await writeFile(resolve(directory, 'one.js'), 'console.log("one");');
    await writeFile(resolve(directory, 'two.js'), 'console.log("two");');
    const measured = await measureInitialJs(directory);
    expect(measured.gzipBytes).toBe(
      gzipSync('console.log("one");').length +
        gzipSync('console.log("two");').length,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
