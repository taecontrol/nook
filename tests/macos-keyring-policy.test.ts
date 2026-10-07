import { Effect, Sink, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { expect, it } from 'vitest';
import { readMachineName, readToken } from '../apps/cli/src/keyring-macos.ts';

// Native keychain acceptance stays in macos-cli.test.ts. These transcripts cover
// malformed/error responses that a healthy private keychain cannot produce.
const failure =
  process.platform === 'darwin'
    ? 'Nook keeps its token in the macOS login keychain and could not use it. Unlock your login keychain and try again.'
    : 'Nook keeps its token in the Secret Service keyring and could not use it. Install secret-tool (libsecret), unlock your keyring, and try again.';
const origin = 'https://synthetic.nook.test';

async function securityResult<A>(
  operation: Effect.Effect<A, Error, ChildProcessSpawner.ChildProcessSpawner>,
  status: number,
  stdout: string,
) {
  const calls: ChildProcess.Command[] = [];
  const output = Stream.make(new TextEncoder().encode(stdout));
  const spawner = ChildProcessSpawner.make((command) => {
    calls.push(command);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(42),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(status)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: output,
        stderr: Stream.make(
          new TextEncoder().encode('Synthetic private diagnostic'),
        ),
        all: output,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    );
  });
  const result = await Effect.runPromise(
    operation.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.catch((error) => Effect.succeed({ failure: error.message })),
    ),
  );
  expect(calls).toHaveLength(1);
  const command = calls[0];
  if (!ChildProcess.isStandardCommand(command))
    throw new Error('Expected a security command.');
  expect(command.command).toBe('security');
  return { result, args: command.args };
}

it.each([
  [44, '', undefined],
  [0, 'synthetic-keychain-token\n', 'synthetic-keychain-token'],
  [0, '', { failure }],
  [44, 'unexpected private output', { failure }],
  [1, 'unexpected private output', { failure }],
] as const)(
  'macOS token lookup translates security status %s without returning diagnostics',
  async (status, output, expected) => {
    const { result, args } = await securityResult(
      readToken(origin),
      status,
      output,
    );
    expect(
      result === expected ||
        JSON.stringify(result) === JSON.stringify(expected),
    ).toBe(true);
    expect(args).toEqual([
      'find-generic-password',
      '-s',
      'nook',
      '-a',
      origin,
      '-w',
    ]);
  },
);

it.each([
  [
    0,
    '    0x00000007 <blob>="Nook machine "synthetic machine""',
    'synthetic machine',
  ],
  [
    0,
    `    0x00000007 <blob>=0x${Buffer.from('Nook machine "máquina 😀"').toString('hex')}  "display"`,
    'máquina 😀',
  ],
  [1, 'Synthetic private failure', { failure }],
  [0, '    "acct" <blob>="private account"', { failure }],
  [0, '    0x00000007 <blob>="Other application"', { failure }],
  [0, '    0x00000007 <blob>="Nook machine 42"', { failure }],
  [
    0,
    '    0x00000007 <blob>="Nook machine {private invalid JSON}"',
    { failure },
  ],
] as const)(
  'macOS machine metadata translates transcript %s/%s without exposing malformed labels',
  async (status, output, expected) => {
    const { result, args } = await securityResult(
      readMachineName(origin),
      status,
      output,
    );
    expect(
      result === expected ||
        JSON.stringify(result) === JSON.stringify(expected),
    ).toBe(true);
    expect(args).toEqual(['find-generic-password', '-s', 'nook', '-a', origin]);
  },
);
