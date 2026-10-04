import { vi } from 'vitest';

vi.mock('../../scripts/runtime.ts', async (original) => {
  const actual = await original<typeof import('../../scripts/runtime.ts')>();
  let starts = 0;
  return {
    ...actual,
    startRuntime: (options: Parameters<typeof actual.startRuntime>[0]) => {
      if (++starts === 2)
        throw new Error('Synthetic bucket runtime startup failure.');
      return actual.startRuntime(options);
    },
  };
});
