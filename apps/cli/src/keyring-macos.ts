import { Effect } from 'effect';
import { CliFailure, keyringMessage } from './errors.ts';
import { keyringCommand, requireKeyringSuccess } from './keyring-command.ts';

function security(args: string[], input = '') {
  return keyringCommand('security', args, '2 minutes', input);
}

function quote(value: string) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function store(service: string, account: string, label: string, value: string) {
  // Interactive mode receives exactly one command: only its status is reliable.
  // The credential is transported on stdin, never through process arguments.
  return security(
    ['-i'],
    `add-generic-password -s ${quote(service)} -a ${quote(account)} -l ${quote(label)} -w ${quote(value)}\n`,
  ).pipe(Effect.flatMap(requireKeyringSuccess));
}

function clear(service: string, account: string) {
  return security([
    'delete-generic-password',
    '-s',
    service,
    '-a',
    account,
  ]).pipe(
    Effect.flatMap((result) =>
      result.status === 44 ? Effect.void : requireKeyringSuccess(result),
    ),
  );
}

export const checkKeyring = Effect.gen(function* () {
  const nonce = crypto.randomUUID();
  yield* store('nook-check', nonce, 'Nook keyring check', 'ready');
  yield* clear('nook-check', nonce);
});

export function readToken(url: string) {
  return security([
    'find-generic-password',
    '-s',
    'nook',
    '-a',
    url,
    '-w',
  ]).pipe(
    Effect.flatMap((result) => {
      if (result.status === 44 && !result.output)
        return Effect.succeed(undefined);
      if (result.status !== 0 || !result.output)
        return Effect.fail(new CliFailure(keyringMessage));
      return Effect.succeed(result.output);
    }),
  );
}

export function readMachineName(url: string) {
  return security(['find-generic-password', '-s', 'nook', '-a', url]).pipe(
    Effect.flatMap((result) =>
      Effect.try({
        try: () => {
          if (result.status !== 0) throw new Error();
          // security's database schema prints the label's numeric tag, not "labl".
          const encoded = /^\s*0x00000007\s+<blob>=(.+)$/m.exec(
            result.output,
          )?.[1];
          if (!encoded) throw new Error();
          const hex = /^0x([\da-f]+)(?:\s|$)/i.exec(encoded)?.[1];
          // security prints non-ASCII labels as UTF-8 hex and ASCII as quoted text.
          const label = hex
            ? Buffer.from(hex, 'hex').toString('utf8')
            : encoded.slice(1, -1);
          if (!label.startsWith('Nook machine ')) throw new Error();
          const name: unknown = JSON.parse(label.slice('Nook machine '.length));
          if (typeof name !== 'string') throw new Error();
          return name;
        },
        catch: () => new CliFailure(keyringMessage),
      }),
    ),
  );
}

export function storeToken(url: string, machine: string, token: string) {
  return store('nook', url, `Nook machine ${JSON.stringify(machine)}`, token);
}

export function clearToken(url: string) {
  return clear('nook', url);
}
