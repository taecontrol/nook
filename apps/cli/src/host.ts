import type { Effect, Scope } from 'effect';
import type { ChildProcessSpawner } from 'effect/process';
import type { CliFailure } from './errors.ts';
import * as macosKeychain from './keyring-macos.ts';
import * as secretService from './keyring-secret-service.ts';
import { linuxLock, macosLock } from './session-lock.ts';

// The CLI decides its platform once, at the entry point, and passes the result
// to every command.
export type Host = {
  readonly platform: 'linux' | 'darwin';
  readonly keyring: Omit<typeof secretService, 'keyringMessage'>;
  readonly lockSession: Effect.Effect<
    unknown,
    CliFailure,
    Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
  >;
  readonly browser: 'xdg-open' | 'open';
};
export function hostFor(platform: NodeJS.Platform): Host | undefined {
  if (platform === 'linux')
    return {
      platform,
      keyring: secretService,
      lockSession: linuxLock,
      browser: 'xdg-open',
    };
  if (platform === 'darwin')
    return {
      platform,
      keyring: macosKeychain,
      lockSession: macosLock,
      browser: 'open',
    };
  return undefined;
}
