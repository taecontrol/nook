import { defineConfig } from 'vitest/config';
import { coveragePlugin } from './scripts/lib/instrument.ts';

export default defineConfig({
  plugins: process.env.COVERAGE_RUN ? [coveragePlugin()] : [],
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    maxWorkers: 3,
    setupFiles: ['tests/coverage-setup.ts'],
    expect: { poll: { timeout: 5_000 } },
  },
});
