import { Effect } from 'effect';
import { CliFailure, keyringMessage } from './errors.ts';
import { keyringCommand, requireKeyringSuccess } from './keyring-command.ts';

function secretTool(args: string[], input = '') {
  return keyringCommand('secret-tool', args, '10 seconds', input);
}
export const checkKeyring = Effect.gen(function* () {
  const nonce = crypto.randomUUID();
  const stored = yield* secretTool(
    [
      'store',
      '--label=Nook keyring check',
      'service',
      'nook-check',
      'nonce',
      nonce,
    ],
    'ready',
  );
  yield* requireKeyringSuccess(stored);
  const cleared = yield* secretTool([
    'clear',
    'service',
    'nook-check',
    'nonce',
    nonce,
  ]);
  yield* requireKeyringSuccess(cleared);
});
export function readToken(url: string) {
  return secretTool(['lookup', 'service', 'nook', 'url', url]).pipe(
    Effect.flatMap((result) => {
      if (
        result.diagnostic ||
        ![0, 1].includes(result.status) ||
        (result.status === 1 && result.output)
      )
        return Effect.fail(new CliFailure(keyringMessage));
      return Effect.succeed(result.output || undefined);
    }),
  );
}
export function readMachineName(url: string) {
  return secretTool(['search', 'service', 'nook', 'url', url]).pipe(
    Effect.flatMap((result) =>
      Effect.try({
        try: () => {
          const label = /^label = Nook machine (.+)$/m.exec(result.output)?.[1];
          const name: unknown = JSON.parse(label ?? 'null');
          if (typeof name !== 'string') throw new Error();
          return name;
        },
        catch: () => new CliFailure(keyringMessage),
      }),
    ),
  );
}
export function storeToken(url: string, machine: string, token: string) {
  return secretTool(
    [
      'store',
      `--label=Nook machine ${JSON.stringify(machine)}`,
      'service',
      'nook',
      'url',
      url,
    ],
    token,
  ).pipe(Effect.flatMap(requireKeyringSuccess));
}
export function clearToken(url: string) {
  return secretTool(['clear', 'service', 'nook', 'url', url]).pipe(
    Effect.flatMap(requireKeyringSuccess),
  );
}
