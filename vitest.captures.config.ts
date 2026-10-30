import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

// Delivery evidence: screenshots to compare with a chosen prototype.
// Run on demand with `pnpm captures`; CI and `pnpm verify` never run them.
export default defineConfig({
  ...base,
  test: { ...base.test, include: ['tests/captures/*.capture.ts'] },
});
