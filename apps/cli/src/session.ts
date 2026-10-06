import { hostname } from 'node:os';
import { limitedAccessText, readOnlyText } from '@nook/contract';
import { Effect } from 'effect';
import { machineApi } from './api.ts';
import { installationOrigin, readConfig, writeConfig } from './config.ts';
import { CliFailure } from './errors.ts';
import {
  checkKeyring,
  clearToken,
  openBrowser,
  readMachineName,
  readToken,
  storeToken,
} from './keyring.ts';
import { lockSession } from './session-lock.ts';

type Write = (message: string) => void;
type Approved = { token: string; machine: string };
function notLoggedIn(url?: string) {
  return new CliFailure(
    `Not logged in. Run: nook login ${url ?? '<your Nook URL>'}`,
  );
}
function networkError(url: string) {
  return new CliFailure(`Could not reach ${url}. Try again.`);
}
const session = Effect.gen(function* () {
  yield* checkKeyring;
  const url = yield* readConfig;
  if (!url) return yield* Effect.fail(notLoggedIn());
  const token = yield* readToken(url);
  if (!token) return yield* Effect.fail(notLoggedIn(url));
  return { url, token, request: machineApi(url) };
});
function waitForApproval(url: string, deviceCode: string, interval: number) {
  const request = machineApi(url);
  const poll = request((api) =>
    api.machine.poll({ payload: { deviceCode } }),
  ).pipe(
    Effect.catch((error) => {
      if (error.tag === 'pending') return Effect.succeed(undefined);
      if (error.tag === 'denied')
        return Effect.fail(new CliFailure('Login denied. Nothing was stored.'));
      if (error.tag === 'expired')
        return Effect.fail(
          new CliFailure(`The login request expired. Run: nook login ${url}`),
        );
      if (error.tag === 'invalid')
        return Effect.fail(
          new CliFailure(
            `The login request is no longer valid. Run: nook login ${url}`,
          ),
        );
      return Effect.fail(networkError(url));
    }),
  );
  return Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(`${interval} seconds`);
      const approved = yield* poll;
      if (approved) return approved;
    }
  });
}
function revokeIssued(url: string, token: string) {
  return machineApi(url)((api) =>
    api.machine.logout({ headers: { authorization: `Bearer ${token}` } }),
  ).pipe(
    Effect.catch((error) =>
      error.tag === 'Unauthorized' ? Effect.void : Effect.fail(error),
    ),
  );
}
function persistApproved(url: string, approved: Approved) {
  return Effect.gen(function* () {
    yield* storeToken(url, approved.machine, approved.token);
    yield* writeConfig(url);
  }).pipe(
    Effect.catch((error) =>
      revokeIssued(url, approved.token).pipe(
        Effect.matchEffect({
          onSuccess: () =>
            clearToken(url).pipe(
              Effect.ignore,
              Effect.andThen(Effect.fail(error)),
            ),
          onFailure: () =>
            Effect.gen(function* () {
              yield* storeToken(url, approved.machine, approved.token).pipe(
                Effect.ignore,
              );
              yield* writeConfig(url).pipe(Effect.ignore);
              return yield* Effect.fail(
                new CliFailure(
                  `${error.message} The issued token could not be revoked. Fix the configuration path and keyring, then run: nook login ${url}`,
                ),
              );
            }),
        }),
      ),
    ),
  );
}
function refuseExisting(url: string, restoreConfig: boolean) {
  return Effect.gen(function* () {
    const token = yield* readToken(url);
    if (!token) return;
    const machine = yield* readMachineName(url);
    if (restoreConfig) yield* writeConfig(url);
    return yield* Effect.fail(
      new CliFailure(
        `Already logged in to ${url} as ${machine}. Run: nook logout`,
      ),
    );
  });
}
export function login(input: string, write: Write) {
  return Effect.scoped(
    Effect.gen(function* () {
      const url = yield* Effect.try({
        try: () => installationOrigin(input),
        catch: () =>
          new CliFailure(
            'Use the HTTPS origin of your Nook installation, without a path, query, or credentials.',
          ),
      });
      yield* lockSession;
      yield* checkKeyring;
      const configured = yield* readConfig;
      if (configured) yield* refuseExisting(configured, false);
      if (configured !== url) yield* refuseExisting(url, true);
      const started = yield* machineApi(url)((api) =>
        api.machine.authorize({
          payload: {
            suggestedName: hostname().slice(0, 64),
            client: `nook 0.1.0 · ${process.platform}-${process.arch}`,
          },
        }),
      ).pipe(
        Effect.mapError((error) =>
          error.tag === 'PendingLimit'
            ? new CliFailure(
                'Too many pending login requests. Wait a few minutes and try again.',
              )
            : networkError(url),
        ),
      );
      write(
        `Open ${url}/cli/authorize and enter this code:\n\n    ${started.userCode}\n\nWaiting for approval (expires in 10 minutes)...`,
      );
      yield* openBrowser(`${url}/cli/authorize`).pipe(Effect.forkScoped);
      const approved = yield* waitForApproval(
        url,
        started.deviceCode,
        started.interval,
      );
      yield* persistApproved(url, approved);
      write(
        `Logged in to ${url} as ${approved.machine}. Token stored in the system keyring.`,
      );
    }),
  );
}
export function whoami(write: Write) {
  return Effect.gen(function* () {
    const { url, token, request } = yield* session;
    const identity = yield* request((api) =>
      api.machine.whoami({ headers: { authorization: `Bearer ${token}` } }),
    ).pipe(
      Effect.mapError((error) =>
        error.tag === 'Unauthorized'
          ? new CliFailure(
              `This machine's token is no longer valid. Run: nook login ${url}`,
            )
          : networkError(url),
      ),
    );
    const access =
      identity.grant === 'all'
        ? 'all buckets (current and future)'
        : `${identity.grant.join(', ')} (${limitedAccessText})\n${readOnlyText(identity.grant)}\nAll other buckets: hidden`;
    write(`${identity.machine} at ${url}\nAccess: ${access}`);
  });
}
export function mcpHeader(write: Write) {
  return Effect.gen(function* () {
    const url = yield* readConfig;
    if (!url) return yield* Effect.fail(notLoggedIn());
    const token = yield* readToken(url).pipe(
      Effect.timeout('5 seconds'),
      Effect.mapError(() => notLoggedIn(url)),
    );
    if (!token) return yield* Effect.fail(notLoggedIn(url));
    write(JSON.stringify({ Authorization: `Bearer ${token}` }));
  });
}
export function logout(write: Write) {
  return Effect.scoped(
    Effect.gen(function* () {
      yield* lockSession;
      const { url, token, request } = yield* session;
      yield* request((api) =>
        api.machine.logout({ headers: { authorization: `Bearer ${token}` } }),
      ).pipe(
        Effect.catch((error) =>
          error.tag === 'Unauthorized'
            ? Effect.void
            : Effect.fail(
                new CliFailure(
                  `Could not reach ${url}; the token is still active. Try again.`,
                ),
              ),
        ),
      );
      yield* clearToken(url);
      write(
        `Logged out of ${url}. The token was revoked and removed from the keyring.`,
      );
    }),
  );
}
