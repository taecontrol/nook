// Refresh scripts/lib/test-timings.json from green Verify runs:
//   node scripts/test-timings.ts <run-id> [<run-id> ...]
// Reads each run's Linux and macOS test job logs with the GitHub CLI and
// records every current suite's median seconds per platform.
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

const table = 'scripts/lib/test-timings.json';
const suite = / [✓×↓] (tests\/\S+\.test\.ts) \(\d+ tests?[^)]*\) (\d+)ms/;
const platforms = { linux: 'tests (', darwin: 'macos-cli (' } as const;
type Platform = keyof typeof platforms;

const gh = (path: string) =>
  execFileSync('gh', ['api', '--allow-escape-sequences', path], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });

// Drop the ANSI colour codes vitest writes into CI logs.
const plain = (line: string) =>
  line
    .split(String.fromCharCode(27))
    .map((part, i) => (i ? part.replace(/^\[[0-9;]*m/, '') : part))
    .join('');

function record(log: string, samples: Map<string, number[]>) {
  for (const line of log.split('\n')) {
    const match = suite.exec(plain(line));
    if (!match) continue;
    samples.set(match[1], [
      ...(samples.get(match[1]) ?? []),
      Number(match[2]) / 1000,
    ]);
  }
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

const runs = process.argv.slice(2);
if (!runs.length) throw new Error('Expected one or more Verify run ids.');
const samples = { linux: new Map(), darwin: new Map() } as Record<
  Platform,
  Map<string, number[]>
>;
for (const run of runs) {
  const { jobs } = JSON.parse(
    gh(`repos/{owner}/{repo}/actions/runs/${run}/jobs?per_page=100`),
  ) as { jobs: { id: number; name: string; conclusion: string }[] };
  for (const platform of Object.keys(platforms) as Platform[])
    for (const job of jobs.filter((j) =>
      j.name.startsWith(platforms[platform]),
    ))
      if (job.conclusion === 'success')
        record(
          gh(`repos/{owner}/{repo}/actions/jobs/${job.id}/logs`),
          samples[platform],
        );
}
const current = (platform: Platform) =>
  Object.fromEntries(
    [...samples[platform]]
      .filter(([path]) => existsSync(path))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([path, values]) => [path, Math.round(median(values))]),
  );
writeFileSync(
  table,
  `${JSON.stringify({ linux: current('linux'), darwin: current('darwin') }, null, 2)}\n`,
);
console.log(`Wrote ${table} from ${runs.length} run(s).`);
