import type { FileCoverageData } from 'istanbul-lib-coverage';
import { afterAll } from 'vitest';
import { observe } from '../scripts/observation.ts';

declare global {
  var __coverage__: Record<string, FileCoverageData> | undefined;
  var __authoredModules__: Record<string, string> | undefined;
}

afterAll(async () => {
  if (process.env.COVERAGE_RUN)
    await observe({
      seam: 'node',
      loaded: globalThis.__authoredModules__ ?? {},
      counters: globalThis.__coverage__ ?? {},
    });
});
