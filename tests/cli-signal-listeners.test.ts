import { expect, it } from 'vitest';
import { execute } from '../apps/cli/src/commands.ts';

function signalListeners() {
  return [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
}

it('a command removes its SIGINT and SIGTERM listeners when it ends', async () => {
  const before = signalListeners();
  const output: string[] = [];
  expect(
    await execute(['version'], {
      platform: 'linux',
      write: (message) => output.push(message),
    }),
  ).toBe(0);
  expect(output).toHaveLength(1);
  expect(signalListeners()).toEqual(before);
});
