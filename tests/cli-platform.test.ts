import { existsSync } from 'node:fs';
import { expect, it, vi } from 'vitest';

it.each(['login', 'whoami', 'logout'])(
  'E10: %s on macOS exits with the unsupported message without a request',
  async (command) => {
    expect(
      existsSync('apps/cli/src/commands.ts'),
      'CLI command module is not implemented',
    ).toBe(true);
    const path = '../apps/cli/src/commands.ts';
    const { execute } = await import(path);
    const fetch = vi.spyOn(globalThis, 'fetch');
    const output: string[] = [];
    try {
      const status = await execute(
        command === 'login' ? [command, 'https://nook.test'] : [command],
        {
          platform: 'darwin',
          write: (message: string) => output.push(message),
        },
      );
      expect(status).toBe(1);
      expect(output.join('\n')).toBe(
        'Keeping the token in the macOS Keychain is not supported yet.',
      );
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  },
);
