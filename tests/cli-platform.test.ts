import { expect, it, vi } from 'vitest';

it.each(['login', 'whoami', 'logout', 'mcp-header'])(
  'E15: %s on unsupported platforms exits without a request',
  async (command) => {
    const path = '../apps/cli/src/commands.ts';
    const { execute } = await import(path);
    const fetch = vi.spyOn(globalThis, 'fetch');
    const output: string[] = [];
    try {
      const status = await execute(
        command === 'login' ? [command, 'https://nook.test'] : [command],
        {
          platform: 'win32',
          write: (message: string) => output.push(message),
        },
      );
      expect(status).toBe(1);
      expect(output.join('\n')).toBe(
        'The Nook CLI supports Linux and macOS only.',
      );
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  },
);
