import type { FileCoverageData } from 'istanbul-lib-coverage';
import { afterAll } from 'vitest';
import { trackMacFixtureProcesses } from '../scripts/lib/macos-process-groups.ts';
import { observe } from '../scripts/observation.ts';

trackMacFixtureProcesses();

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
