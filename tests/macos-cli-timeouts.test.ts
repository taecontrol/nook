import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Effect, Fiber } from 'effect';
import { ChildProcessSpawner } from 'effect/process';
import { TestClock } from 'effect/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkKeyring,
  clearToken,
  readMachineName,
  readToken,
  storeToken,
} from '../apps/cli/src/keyring-macos.ts';
import { login, logout, whoami } from '../apps/cli/src/session.ts';
import { ownerRuntime } from './support/authorizations.ts';
import { issueGrant } from './support/grants.ts';
import {
  type PrivateMacKeychain,
  privateMacKeychain,
} from './support/macos-keychain.ts';
import { runtime, type TestRuntime } from './support/runtime.ts';

// Coordination is independently proven by real CLI processes in E13/E14.
vi.mock('../apps/cli/src/session-lock.ts', async () => {
  const { Effect } = await import('effect');
  return { lockSession: Effect.void };
});

describe.runIf(process.platform === 'darwin')(
  'macOS keychain deadline at the CLI module seam',
  () => {
    let app: TestRuntime;
    let keyring: PrivateMacKeychain;
    beforeEach(async () => {
      app = await ownerRuntime(await runtime());
      keyring = await privateMacKeychain();
      const issued = await issueGrant(app, ['me']);
      expect(await keyring.store(app.origin, issued.token)).toBe(0);
      await mkdir(dirname(keyring.config), { recursive: true });
      await writeFile(keyring.config, JSON.stringify({ url: app.origin }));
      return async () => {
        await keyring.close();
        await app.close();
      };
    });
    it.each(['login', 'whoami', 'logout'] as const)(
      'E11: %s waits until 120 seconds, fails privately, and preserves the credential',
      async (command) => {
        const token = await keyring.lookup(app.origin);
        const output: string[] = [];
        const stalled = ChildProcessSpawner.make(() => Effect.never);
        let failure = '';
        let settled = false;
        const operation =
          command === 'login'
            ? login(app.origin, (message) => output.push(message))
            : command === 'whoami'
              ? whoami((message) => output.push(message))
              : logout((message) => output.push(message));
        await Effect.runPromise(
          Effect.gen(function* () {
            const fiber = yield* Effect.scoped(operation).pipe(
              Effect.provideService(
                ChildProcessSpawner.ChildProcessSpawner,
                stalled,
              ),
              Effect.catch((error) =>
                Effect.sync(() => {
                  failure = error.message;
                }),
              ),
              Effect.tap(() =>
                Effect.sync(() => {
                  settled = true;
                }),
              ),
              Effect.forkChild,
            );
            yield* TestClock.adjust('119 seconds');
            expect(settled).toBe(false);
            yield* TestClock.adjust('1 second');
            yield* Fiber.join(fiber);
          }).pipe(Effect.provide(TestClock.layer())),
        );
        expect(settled).toBe(true);
        expect(
          failure ===
            'Nook keeps its token in the macOS login keychain and could not use it. Unlock your login keychain and try again.',
          'Exact public keychain failure without private diagnostics',
        ).toBe(true);
        expect(output.length).toBe(0);
        expect(
          (await keyring.lookup(app.origin)) === token,
          'Timeout retains the credential, including on logout',
        ).toBe(true);
      },
    );
    it.each(['probe', 'read', 'metadata', 'store', 'clear'] as const)(
      'E11: the %s operation shares the 120-second deadline',
      async (phase) => {
        const token = await keyring.lookup(app.origin);
        const operation =
          phase === 'probe'
            ? checkKeyring
            : phase === 'read'
              ? readToken(app.origin)
              : phase === 'metadata'
                ? readMachineName(app.origin)
                : phase === 'store'
                  ? storeToken(app.origin, 'macbook', token)
                  : clearToken(app.origin);
        let settled = false;
        let failure = '';
        await Effect.runPromise(
          Effect.gen(function* () {
            const fiber = yield* Effect.scoped(operation).pipe(
              Effect.provideService(
                ChildProcessSpawner.ChildProcessSpawner,
                ChildProcessSpawner.make(() => Effect.never),
              ),
              Effect.catch((error) =>
                Effect.sync(() => {
                  failure = error.message;
                }),
              ),
              Effect.tap(() =>
                Effect.sync(() => {
                  settled = true;
                }),
              ),
              Effect.forkChild,
            );
            yield* TestClock.adjust('119 seconds');
            expect(settled).toBe(false);
            yield* TestClock.adjust('1 second');
            yield* Fiber.join(fiber);
          }).pipe(Effect.provide(TestClock.layer())),
        );
        expect(settled).toBe(true);
        expect(
          failure ===
            'Nook keeps its token in the macOS login keychain and could not use it. Unlock your login keychain and try again.',
        ).toBe(true);
        expect((await keyring.lookup(app.origin)) === token).toBe(true);
      },
    );
  },
);
