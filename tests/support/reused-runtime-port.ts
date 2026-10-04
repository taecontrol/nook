import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, expect, vi } from 'vitest';
import type { TestRuntime } from './runtime.ts';

const selection = vi.hoisted(() => ({ port: 0 }));
let successor: TestRuntime | undefined;

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      try {
        return await actual.stat(...args);
      } catch (error) {
        const path = String(args[0]);
        if (
          !successor &&
          path.startsWith(`${resolve(tmpdir(), 'nook-test-ports')}/`) &&
          (error as NodeJS.ErrnoException).code === 'ENOENT'
        ) {
          selection.port = Number(path.split('/').at(-1));
          const crypto = await import('node:crypto');
          const randomInt = crypto.randomInt;
          const picker = vi
            .spyOn(crypto, 'randomInt')
            .mockImplementation(((minimum: number, maximum: number) =>
              minimum <= selection.port && selection.port < maximum
                ? selection.port
                : randomInt(minimum, maximum)) as typeof randomInt);
          const { runtime } = await import('./runtime.ts');
          try {
            successor = await runtime();
          } finally {
            picker.mockRestore();
          }
        }
        throw error;
      }
    },
  };
});

afterAll(async () => {
  expect(
    successor,
    'The released port must be reused before cleanup.',
  ).toBeDefined();
  if (!successor) return;
  try {
    expect(new URL(successor.origin).port).toBe(String(selection.port));
    await stat(resolve(tmpdir(), 'nook-test-ports', String(selection.port)));
    expect((await fetch(`${successor.origin}/`)).status).toBe(200);
  } finally {
    // Keep a missing successor lease diagnostic when testing the broken cleanup.
    await successor.close().catch(() => {});
  }
});
