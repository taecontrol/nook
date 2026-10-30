import { relative } from 'node:path';
import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { coveragePlugin } from './scripts/lib/instrument.ts';
import { assignShards } from './scripts/lib/test-shards.ts';

// Shards files by their measured CI time instead of a path hash.
class TimedSequencer extends BaseSequencer {
  private path(spec: TestSpecification) {
    return relative(this.ctx.config.root, spec.moduleId).replaceAll('\\', '/');
  }

  async shard(files: TestSpecification[]) {
    const { index, count } = this.ctx.config.shard ?? { index: 1, count: 1 };
    const mine = new Set(
      assignShards(
        files.map((f) => this.path(f)),
        count,
      )[index - 1],
    );
    return files.filter((f) => mine.has(this.path(f)));
  }
}

export default defineConfig({
  plugins: process.env.COVERAGE_RUN ? [coveragePlugin()] : [],
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    maxWorkers: 3,
    setupFiles: ['tests/coverage-setup.ts'],
    globalSetup: ['scripts/lib/host-isolation.ts'],
    expect: { poll: { timeout: 5_000 } },
    sequence: { sequencer: TimedSequencer },
  },
});
