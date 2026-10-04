import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

export function initialScripts(html: string): string[] {
  const sources = new Set<string>();
  for (const tag of html.match(/<(?:script|link)\b[^>]*>/g) ?? []) {
    const isScript = /^<script\b/.test(tag);
    const isPreload = /\brel="modulepreload"/.test(tag);
    if (!isScript && !isPreload) continue;
    const source = /\b(?:src|href)="([^"]+)"/.exec(tag)?.[1];
    if (source) sources.add(source);
  }
  return [...sources];
}

export async function measureInitialJs(assetDirectory: string) {
  const html = await readFile(join(assetDirectory, 'index.html'), 'utf8');
  const files = [];
  for (const source of initialScripts(html)) {
    const bytes = await readFile(join(assetDirectory, source));
    files.push({ source, gzipBytes: gzipSync(bytes).length });
  }
  if (!files.length) throw new Error('The document loads no JavaScript.');
  return {
    files,
    gzipBytes: files.reduce((total, file) => total + file.gzipBytes, 0),
  };
}

export function assertBudget(current: number, previous: number) {
  if (
    !Number.isInteger(current) ||
    current <= 0 ||
    current > Math.min(200_000, previous)
  ) {
    throw new Error(
      'The bundle budget ceiling must be a positive integer and may only go down.',
    );
  }
}

export async function checkBundleBudget({
  assetDirectory = 'dist/assets',
  budgetPath = 'bundle-budget.json',
} = {}) {
  const budget = JSON.parse(await readFile(budgetPath, 'utf8')) as {
    initialJsGzipBytes: number;
  };
  assertBudget(budget.initialJsGzipBytes, 200_000);
  const measured = await measureInitialJs(assetDirectory);
  return {
    ...measured,
    ceiling: budget.initialJsGzipBytes,
    passed: measured.gzipBytes <= budget.initialJsGzipBytes,
  };
}
