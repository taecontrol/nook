import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { Effect, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { CliFailure, keyringMessage } from './errors.ts';

const busIdentity = Effect.scoped(
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        'dbus-send',
        [
          '--session',
          '--print-reply=literal',
          '--dest=org.freedesktop.DBus',
          '/org/freedesktop/DBus',
          'org.freedesktop.DBus.GetId',
        ],
        { stdin: 'ignore', stderr: 'ignore' },
      ),
    );
    const [output, status] = yield* Effect.all(
      [Stream.mkString(Stream.decodeText(child.stdout)), child.exitCode],
      { concurrency: 'unbounded' },
    );
    const id = output.trim();
    if (Number(status) !== 0 || !/^[a-f0-9]{32}$/.test(id))
      return yield* Effect.fail(new CliFailure(keyringMessage));
    return id;
  }),
).pipe(
  Effect.timeout('10 seconds'),
  Effect.mapError(() => new CliFailure(keyringMessage)),
);

function acquireSocket(busId: string) {
  return Effect.tryPromise({
    try: () =>
      new Promise<Server>((resolve, reject) => {
        // D-Bus GetId identifies the actual bus across equivalent addresses.
        // Config paths are not identities: two configs can share one keyring.
        const identity = `${process.getuid?.()}-${busId}`;
        const server = createServer((socket) => socket.destroy());
        server.once('error', reject);
        // Linux releases this abstract socket on exit, including SIGKILL.
        // No lock file or credential is written or sent through the socket.
        server.listen(`\0nook-session-${identity}`, () => resolve(server));
      }),
    catch: (error) =>
      new CliFailure(
        (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
          ? 'Another Nook session command is in progress. Finish it before starting a new one.'
          : 'Could not protect the Nook session. Try again.',
      ),
  });
}

const acquire = busIdentity.pipe(Effect.flatMap(acquireSocket));

const linuxLock = Effect.acquireRelease(acquire, (server) =>
  Effect.promise(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  ),
);

const macosLock = Effect.acquireRelease(
  Effect.tryPromise({
    try: async () => {
      const directory = resolve(homedir(), 'Library/Application Support/nook');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // O_EXLOCK is Darwin's kernel-held lock. Node does not name this flag.
      // Never unlink: that would let a concurrent opener lock another inode.
      return open(
        resolve(directory, 'session.lock'),
        constants.O_CREAT | constants.O_RDWR | constants.O_NONBLOCK | 0x20,
        0o600,
      );
    },
    catch: (error) =>
      new CliFailure(
        ['EAGAIN', 'EWOULDBLOCK'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
          ? 'Another Nook session command is in progress. Finish it before starting a new one.'
          : 'Could not protect the Nook session. Try again.',
      ),
  }),
  (file) => Effect.promise(() => file.close()),
);

export const lockSession =
  process.platform === 'darwin' ? macosLock : linuxLock;
