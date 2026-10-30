import timings from './test-timings.json' with { type: 'json' };

// Seconds each test file took in CI. A file missing from the table counts as
// the median measured file until the table is refreshed.
export type Timings = Record<string, number>;

function estimator(table: Timings) {
  const known = Object.values(table).sort((a, b) => a - b);
  const fallback = known.length ? known[Math.floor(known.length / 2)] : 1;
  return (file: string) => table[file] ?? fallback;
}

// Slowest first; the path breaks ties so every shard job derives the same order.
export function bySlowest(files: string[], table: Timings = timings) {
  const estimate = estimator(table);
  return [...files].sort(
    (a, b) => estimate(b) - estimate(a) || (a < b ? -1 : a > b ? 1 : 0),
  );
}

// Longest processing time first: each file joins the shard with the least
// estimated work, so no shard waits on two slow suites another shard lacks.
export function assignShards(
  files: string[],
  count: number,
  table: Timings = timings,
) {
  const estimate = estimator(table);
  const shards: string[][] = Array.from({ length: count }, () => []);
  const load: number[] = Array(count).fill(0);
  for (const file of bySlowest(files, table)) {
    const lightest = load.indexOf(Math.min(...load));
    shards[lightest].push(file);
    load[lightest] += estimate(file);
  }
  return shards;
}
