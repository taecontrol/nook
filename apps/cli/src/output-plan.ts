import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  openSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isatty } from 'node:tty';
import { Effect } from 'effect';
import { CliFailure } from './errors.ts';

export const maskingStartFailure = () =>
  new CliFailure('Nook could not start output masking. Try again.');
export type RelayStreams = readonly {
  readonly read: number;
  readonly target: 1 | 2;
}[];
export type MaskedPlan = {
  readonly kind: 'masked';
  readonly child: [number | 'inherit', number | 'inherit'];
  readonly relay: RelayStreams;
  readonly closeReaders: () => void;
  readonly closeWriters: () => void;
};
export type OutputPlan = { readonly kind: 'transparent' } | MaskedPlan;

function descriptors() {
  const owned = new Set<number>();
  return {
    add(fd: number) {
      owned.add(fd);
      return fd;
    },
    close() {
      for (const fd of owned) closeSync(fd);
      owned.clear();
    },
  };
}
function fifo(
  directory: string,
  readers: ReturnType<typeof descriptors>,
  writers: ReturnType<typeof descriptors>,
) {
  const path = join(directory, 'output');
  // Resolve the tool through PATH without forwarding inherited values.
  execFileSync('mkfifo', ['-m', '600', path], {
    env: { PATH: process.env.PATH },
    stdio: 'ignore',
  });
  try {
    const openingReader = openSync(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK,
    );
    try {
      const write = writers.add(openSync(path, constants.O_WRONLY));
      // Opening a blocking reader cannot wait now that the writer is open.
      // fs.read needs this blocking fd to see both partial writes and EOF.
      const read = readers.add(openSync(path, constants.O_RDONLY));
      return { read, write };
    } finally {
      closeSync(openingReader);
    }
  } finally {
    unlinkSync(path);
  }
}
function sharedDestination() {
  const stdout = fstatSync(1);
  const stderr = fstatSync(2);
  return stdout.dev === stderr.dev && stdout.ino === stderr.ino;
}
function addStream(
  plan: {
    child: MaskedPlan['child'];
    relay: { read: number; target: 1 | 2 }[];
  },
  target: 1 | 2,
  makePipe: () => { read: number; write: number },
) {
  if (isatty(target)) return;
  if (target === 2 && plan.relay.length && sharedDestination())
    plan.child[1] = plan.child[0];
  else {
    const pipe = makePipe();
    plan.child[target - 1] = pipe.write;
    plan.relay.push({
      read: pipe.read,
      target,
    });
  }
}
function makePlan(masking: boolean): OutputPlan {
  if (!masking || (isatty(1) && isatty(2))) return { kind: 'transparent' };
  const readers = descriptors();
  const writers = descriptors();
  const directory = mkdtempSync(join(tmpdir(), 'nook-output-'));
  const relay: { read: number; target: 1 | 2 }[] = [];
  const child: MaskedPlan['child'] = ['inherit', 'inherit'];
  try {
    const plan: MaskedPlan = {
      kind: 'masked',
      child,
      relay,
      closeReaders: readers.close,
      closeWriters: writers.close,
    };
    for (const target of [1, 2] as const)
      addStream({ child, relay }, target, () =>
        fifo(directory, readers, writers),
      );
    return plan;
  } catch (error) {
    readers.close();
    writers.close();
    throw error;
  } finally {
    rmdirSync(directory);
  }
}
export function planOutput(masking: boolean) {
  return Effect.acquireRelease(
    Effect.try({ try: () => makePlan(masking), catch: maskingStartFailure }),
    (plan) =>
      Effect.sync(() => {
        if (plan.kind === 'masked') {
          plan.closeReaders();
          plan.closeWriters();
        }
      }),
  );
}
