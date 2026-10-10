import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  assertLoadTimes,
  formatMeasurements,
  initialScripts,
  loadTimeBudgets,
  measureInitialJs,
  median,
} from '../scripts/lib/load-time.ts';

it('E18/E19: cold-open and intent navigation budgets use the median of five samples', async () => {
  expect(() =>
    assertLoadTimes({
      home: [9000, 1000, 999, 700, 1001],
      buckets: [0, 0, 1001, 0, 0],
      navigation: [100, 100, 100, 100, 100],
      authorize: [1000, 1000, 1000, 1000, 1000],
      machines: [500, 500, 500, 500, 500],
      machinesNavigation: [20, 20, 20, 20, 20],
      approvalNavigation: [20, 20, 20, 20, 20],
      vault: Array(5).fill(500),
      vaultNavigation: Array(5).fill(20),
      audit: Array(5).fill(500),
      auditNavigation: Array(5).fill(20),
      memory: Array(5).fill(500),
      memoryNavigation: Array(5).fill(20),
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
it.each([
  ['home', [1001, 1001, 0, 1001, 1001], /cold.*\/|home/i],
  ['buckets', [999, 1001, 1002, 1003, 1004], /buckets/i],
  ['navigation', [90, 101, 102, 103, 104], /navigation|intent/i],
])(
  'E25: an over-budget %s fails for its own timing',
  async (kind, values, message) => {
    expect(() =>
      assertLoadTimes({
        home: [500, 500, 500, 500, 500],
        buckets: [600, 600, 600, 600, 600],
        navigation: [20, 20, 20, 20, 20],
        authorize: [500, 500, 500, 500, 500],
        machines: [500, 500, 500, 500, 500],
        machinesNavigation: [20, 20, 20, 20, 20],
        approvalNavigation: [20, 20, 20, 20, 20],
        vault: Array(5).fill(500),
        vaultNavigation: Array(5).fill(20),
        audit: Array(5).fill(500),
        auditNavigation: Array(5).fill(20),
        memory: Array(5).fill(500),
        memoryNavigation: Array(5).fill(20),
        [String(kind)]: values,
      }),
    ).toThrow(message);
  },
);
it('E20: gzip bytes are printed as diagnostics and never used as a budget', async () => {
  const measured = {
    home: [500, 500, 500, 500, 500],
    buckets: [600, 600, 600, 600, 600],
    navigation: [20, 20, 20, 20, 20],
    authorize: [500, 500, 500, 500, 500],
    machines: [500, 500, 500, 500, 500],
    machinesNavigation: [20, 20, 20, 20, 20],
    approvalNavigation: [20, 20, 20, 20, 20],
    vault: Array(5).fill(500),
    vaultNavigation: Array(5).fill(20),
    audit: Array(5).fill(500),
    auditNavigation: Array(5).fill(20),
    memory: Array(5).fill(500),
    memoryNavigation: Array(5).fill(20),
    gzipBytes: 900_000,
  };
  expect(() => assertLoadTimes(measured)).not.toThrow();
  const diagnostics = formatMeasurements(measured);
  expect(JSON.parse(diagnostics)).toMatchObject({
    medianMs: { home: 500, buckets: 600, navigation: 20 },
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
