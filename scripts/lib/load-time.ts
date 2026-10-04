import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

export const loadTimeBudgets = {
  runs: 5,
  coldOpenMs: 1000,
  navigationMs: 100,
  network: {
    offline: false,
    downloadThroughput: 9_000_000 / 8,
    uploadThroughput: 3_000_000 / 8,
    latency: 85,
  },
} as const;
export type Measurements = {
  home: number[];
  buckets: number[];
  navigation: number[];
  gzipBytes?: number;
};
export function median(samples: number[]) {
  if (
    samples.length !== loadTimeBudgets.runs ||
    samples.some((value) => !Number.isFinite(value) || value < 0)
  )
    throw new Error('Expected five finite non-negative timing samples.');
  return [...samples].sort((a, b) => a - b)[2];
}
export function assertLoadTimes(measured: Measurements) {
  for (const key of ['home', 'buckets', 'navigation'] as const) {
    const budget =
      key === 'navigation'
        ? loadTimeBudgets.navigationMs
        : loadTimeBudgets.coldOpenMs;
    const actual = median(measured[key]);
    if (actual > budget)
      throw new Error(
        `${key === 'navigation' ? 'Intent navigation' : `Cold open ${key === 'home' ? '/' : '/buckets'}`} median ${actual.toFixed(1)} ms exceeds ${budget} ms.`,
      );
  }
}
export function formatMeasurements(measured: Measurements) {
  return JSON.stringify(
    {
      medianMs: {
        home: median(measured.home),
        buckets: median(measured.buckets),
        navigation: median(measured.navigation),
      },
      samplesMs: measured,
      coldOpenGzipBytes: measured.gzipBytes,
    },
    null,
    2,
  );
}
export function initialScripts(html: string): string[] {
  const sources = new Set<string>();
  for (const tag of html.match(/<(?:script|link)\b[^>]*>/g) ?? []) {
    if (!/^<script\b/.test(tag) && !/\brel="modulepreload"/.test(tag)) continue;
    const source = /\b(?:src|href)="([^"]+)"/.exec(tag)?.[1];
    if (source) sources.add(source);
  }
  return [...sources];
}
export async function measureInitialJs(assetDirectory: string) {
  const sources = initialScripts(
    await readFile(join(assetDirectory, 'index.html'), 'utf8'),
  );
  if (!sources.length) throw new Error('The document loads no JavaScript.');
  const files = await Promise.all(
    sources.map(async (source) => ({
      source,
      gzipBytes: gzipSync(await readFile(join(assetDirectory, source))).length,
    })),
  );
  return {
    files,
    gzipBytes: files.reduce((sum, file) => sum + file.gzipBytes, 0),
  };
}
