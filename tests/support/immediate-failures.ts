import { beforeEach, onTestFailed } from 'vitest';

beforeEach(() => {
  onTestFailed(({ task }) => {
    for (const error of task.result?.errors ?? []) console.error(error.message);
  });
});
