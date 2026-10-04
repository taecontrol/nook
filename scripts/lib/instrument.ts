import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import type { FileCoverageData } from 'istanbul-lib-coverage';
import { createInstrumenter } from 'istanbul-lib-instrument';
import type { Plugin } from 'vite';
import { digest, files } from './identity.ts';

export const evidenceRoot = resolve('.local/verification/coverage');
type Configuration = {
  roots: string[];
  complexityRoots: string[];
  extensions: string[];
  generatedInventory: string;
  maximum: number;
};

export async function inventory(tooling = false) {
  const config = JSON.parse(
    await readFile('coverage.config.json', 'utf8'),
  ) as Configuration;
  if (config.maximum !== 8)
    throw new Error('Complexity and CRAP ceilings must remain eight.');
  const generated = JSON.parse(
    await readFile(config.generatedInventory, 'utf8'),
  ) as Record<string, string>;
  for (const [path, hash] of Object.entries(generated)) {
    if (digest(await readFile(path)) !== hash)
      throw new Error(
        `Modified generated component must enter authored scope: ${path}`,
      );
  }
  const roots = tooling ? config.complexityRoots : config.roots;
  const all = [...new Set((await Promise.all(roots.map(files))).flat())];
  for (const path of all) {
    if (/\.(?:js|jsx|mjs|cjs|mts|cts)$/.test(path))
      throw new Error(`Unconfigured executable source: ${path}`);
  }
  return all
    .filter(
      (path) =>
        config.extensions.some((extension) => path.endsWith(extension)) &&
        !path.endsWith('.d.ts') &&
        !generated[path],
    )
    .sort();
}

export async function instrument(path: string) {
  const source = await readFile(path, 'utf8');
  const tool = createInstrumenter({
    esModules: true,
    parserPlugins: ['typescript', 'jsx'],
    compact: false,
  });
  const code = tool.instrumentSync(source, path);
  return {
    code,
    baseline: tool.lastFileCoverage() as FileCoverageData,
    hash: digest(source),
  };
}

export async function prepare() {
  const baselines: Record<
    string,
    { hash: string; baseline: FileCoverageData }
  > = {};
  for (const path of await inventory()) {
    const { hash, baseline } = await instrument(path);
    baselines[path] = { hash, baseline };
  }
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(
    resolve(evidenceRoot, 'baseline.json'),
    JSON.stringify(baselines),
  );
  return baselines;
}

export async function instrumentModule(path: string) {
  const { code, hash } = await instrument(path);
  return `globalThis.__authoredModules__ ??= {}; globalThis.__authoredModules__[${JSON.stringify(path)}] = ${JSON.stringify(hash)};\n${code}`;
}

export function coveragePlugin(): Plugin {
  let scoped: Set<string>;
  return {
    name: 'nook-authored-coverage',
    enforce: 'pre',
    async buildStart() {
      scoped = new Set((await inventory()).map((path) => resolve(path)));
    },
    async transform(_code, id) {
      const path = id.split('?')[0];
      if (scoped.has(path))
        return {
          code: await instrumentModule(relative(process.cwd(), path)),
          map: null,
        };
    },
  };
}
