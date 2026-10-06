import { Effect } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import * as macos from './keyring-macos.ts';
import * as linux from './keyring-secret-service.ts';

const keyring = process.platform === 'darwin' ? macos : linux;
export const {
  checkKeyring,
  readToken,
  readMachineName,
  storeToken,
  clearToken,
} = keyring;

export function openBrowser(url: string) {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    yield* spawner.exitCode(
      ChildProcess.make(
        process.platform === 'darwin' ? 'open' : 'xdg-open',
        [url],
        {
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
        },
      ),
    );
  }).pipe(Effect.timeout('3 seconds'), Effect.ignore);
}
