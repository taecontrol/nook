import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isSea } from 'node:sea';
import type { Duplex } from 'node:stream';
import { Effect, Redacted } from 'effect';
import { CliFailure } from './errors.ts';
import { type MaskedPlan, maskingStartFailure } from './output-plan.ts';

type Delivered = readonly {
  readonly path: string;
  readonly value: Redacted.Redacted<string>;
}[];
const deliveryFailure = () =>
  new CliFailure('Nook could not deliver values to output masking. Try again.');
function replies(control: Duplex) {
  const lines = createInterface({ input: control });
  const queued: string[] = [];
  let ended = false;
  let waiting: ((line: string | undefined) => void) | undefined;
  const end = () => {
    ended = true;
    waiting?.(undefined);
    waiting = undefined;
  };
  lines.on('line', (line) => {
    if (waiting) {
      const accept = waiting;
      waiting = undefined;
      accept(line);
    } else queued.push(line);
  });
  lines.on('close', end);
  control.on('error', end);
  return {
    end,
    next: () =>
      new Promise<string | undefined>((accept) => {
        if (queued.length) accept(queued.shift());
        else if (ended) accept(undefined);
        else waiting = accept;
      }),
  };
}
function relayEnvironment() {
  // The executable and bundle paths are explicit; the relay needs no caller
  // environment (which can already contain values from an outer nook run).
  // The instrumented bundle writes coverage directly to this absolute path.
  const coverage = process.env.NOOK_CLI_COVERAGE;
  return coverage
    ? { NOOK_CLI_COVERAGE: coverage.replace(/\.json$/, '-relay.json') }
    : {};
}
async function launch(plan: MaskedPlan) {
  const args = [
    ...(isSea() ? [] : [process.argv[1]]),
    '--nook-output-relay',
    JSON.stringify(plan.relay.map(({ target }) => target)),
  ];
  const child = spawn(process.execPath, args, {
    detached: true,
    env: relayEnvironment(),
    // fd 3 is control, followed by N nonblocking and N blocking FIFO readers.
    stdio: [
      'ignore',
      1,
      2,
      'pipe',
      ...plan.relay.map(({ read }) => read),
      ...plan.relay.map(({ blockingRead }) => blockingRead),
    ],
  });
  child.on('error', () => {});
  child.unref();
  plan.closeReaders();
  const control = child.stdio[3] as Duplex;
  if (!control) throw maskingStartFailure();
  const response = replies(control);
  child.once('error', response.end);
  const close = () => control.destroy();
  if ((await response.next()) !== 'ready') {
    close();
    throw maskingStartFailure();
  }
  return {
    close,
    send: (values: Delivered) =>
      Effect.tryPromise({
        try: async () => {
          control.write(
            JSON.stringify({
              type: 'values',
              values: values.map(({ path, value }) => ({
                path,
                value: Redacted.value(value),
              })),
            }) + '\n',
          );
          if ((await response.next()) !== 'values') throw deliveryFailure();
        },
        catch: deliveryFailure,
      }),
    flushed: () =>
      Effect.promise(async () => {
        if (!control.destroyed) control.write('{"type":"flush"}\n');
        await response.next();
      }),
  };
}
export function startRelay(plan: MaskedPlan) {
  return Effect.acquireRelease(
    Effect.tryPromise({ try: () => launch(plan), catch: maskingStartFailure }),
    (relay) =>
      Effect.sync(() => {
        relay.close();
      }),
  );
}
