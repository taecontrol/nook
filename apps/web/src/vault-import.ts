import { secretPath } from '@nook/contract';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import type { Redacted } from 'effect';
import { useSyncExternalStore } from 'react';
import { ApiError } from './api-client';
import {
  executeWrite,
  failureMessage,
  type ObservedWrite,
  readVaultWrites,
  refreshVault,
  type SecretWrite,
  unconfirmed,
  vaultGate,
} from './vault-api';
import type { ImportRow, ImportSelection } from './vault-import-model';

export type ImportOutcome =
  | 'queued'
  | 'creating'
  | 'created'
  | 'exists'
  | 'failed'
  | 'unconfirmed';
export type ImportKey = {
  path: string;
  name: string;
  description: string;
  outcome: ImportOutcome;
  reason?: string;
};
export type ImportRun = {
  bucket: string;
  keys: readonly ImportKey[];
  settled: boolean;
  skipped: readonly { id: string; name: string; why: string }[];
  unreadable: readonly number[];
};
type ImportDetails = Pick<ImportRun, 'skipped' | 'unreadable'>;

function successOutcome(write: ObservedWrite): ImportOutcome {
  if (!write.result?.secret) return 'failed';
  return write.result.secret.version === write.input.writeId
    ? 'created'
    : 'exists';
}
function outcome(write: ObservedWrite | undefined): ImportOutcome {
  if (!write || write.status === 'idle') return 'queued';
  if (write.status === 'pending') return write.queued ? 'queued' : 'creating';
  if (write.status === 'success') return successOutcome(write);
  return errorOutcome(write);
}
function errorOutcome(write: ObservedWrite): ImportOutcome {
  if (unconfirmed(write.error)) return 'unconfirmed';
  return write.error instanceof ApiError && write.error.tag === 'SecretExists'
    ? 'exists'
    : 'failed';
}
function keyFor(
  input: SecretWrite,
  write: ObservedWrite | undefined,
): ImportKey {
  const state = outcome(write);
  return {
    ...input.secret,
    outcome: state,
    reason: reasonFor(state, write),
  };
}
function failureReason(write: ObservedWrite | undefined) {
  if (!write) return undefined;
  return (
    write.result?.message ?? failureMessage(write, write.error as ApiError)
  );
}
function reasonFor(state: ImportOutcome, write: ObservedWrite | undefined) {
  if (state === 'unconfirmed')
    return 'The response was lost. Nook will check it on the next refresh.';
  return state === 'failed' ? failureReason(write) : undefined;
}
export function retryable(key: ImportKey) {
  return key.outcome === 'failed' || key.outcome === 'unconfirmed';
}
function pending(key: ImportKey) {
  return key.outcome === 'queued' || key.outcome === 'creating';
}
function fromRow(bucket: string, batch: string, row: ImportRow): SecretWrite {
  const writeId = crypto.randomUUID();
  return {
    op: 'create',
    batch,
    writeId,
    expectedVersion: writeId,
    secret: {
      bucket,
      name: row.name,
      description: row.description,
      path: secretPath({ bucket, name: row.name }),
      version: writeId,
      updatedAt: new Date().toISOString(),
    },
  };
}
function requestPool() {
  let active = 0;
  const queue: (() => void)[] = [];
  return {
    ready: () =>
      new Promise<void>((resolve) => {
        if (active < 3) {
          active++;
          resolve();
        } else queue.push(resolve);
      }),
    release: () => {
      const next = queue.shift();
      if (next) next();
      else active--;
    },
  };
}
function warnOnLeave(event: BeforeUnloadEvent) {
  event.preventDefault();
  event.returnValue = '';
}

function createSession(queries: QueryClient) {
  let inputs: SecretWrite[] = [];
  const values = new Map<string, Redacted.Redacted<string>>();
  let snapshot: ImportRun | null = null;
  let details: ImportDetails = { skipped: [], unreadable: [] };
  let warned = false;
  const listeners = new Set<() => void>();
  let unsubscribe = () => {};

  function publish() {
    const writes = new Map(
      readVaultWrites(queries).map((write) => [write.input.writeId, write]),
    );
    const keys = inputs.map((input) =>
      keyFor(input, writes.get(input.writeId)),
    );
    snapshot = inputs.length
      ? {
          ...details,
          bucket: inputs[0].secret.bucket,
          keys,
          settled: !keys.some(pending),
        }
      : null;
    const warning = snapshot !== null && !snapshot.settled;
    if (warning !== warned) {
      window[warning ? 'addEventListener' : 'removeEventListener'](
        'beforeunload',
        warnOnLeave,
      );
      warned = warning;
    }
    for (const listener of listeners) listener();
  }
  function observe() {
    const mutations = queries.getMutationCache().subscribe((event) => {
      if (event.type === 'updated') publish();
    });
    const cache = queries.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.query.queryKey[0] === 'vault')
        publish();
    });
    unsubscribe = () => {
      mutations();
      cache();
    };
  }
  function run(selected: readonly SecretWrite[]) {
    const pool = requestPool();
    // Register the entire queue synchronously: at least one write stays pending
    // until the final request settles, including between request slots.
    const writes = selected.map((input) =>
      executeWrite(
        queries,
        input,
        values.get(input.writeId) as Redacted.Redacted<string>,
        pool.ready,
      )
        .catch(() => {})
        .finally(pool.release),
    );
    void Promise.all(writes)
      .then(() => refreshVault(queries))
      .catch(() => {});
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start(
      bucket: string,
      selection: ImportSelection,
      metadata: ImportDetails = { skipped: [], unreadable: [] },
    ) {
      if (snapshot || !selection.length) return false;
      return vaultGate.start(queries, () => {
        const batch = crypto.randomUUID();
        details = metadata;
        inputs = selection.map(({ row, value }) => {
          const input = fromRow(bucket, batch, row);
          values.set(input.writeId, value);
          return input;
        });
        observe();
        run(inputs);
        publish();
      });
    },
    retryFailed() {
      if (!snapshot?.settled) return;
      const paths = new Set(
        snapshot.keys.filter(retryable).map((key) => key.path),
      );
      const selected = inputs.filter((input) => paths.has(input.secret.path));
      if (selected.length) vaultGate.start(queries, () => run(selected));
    },
    dismiss() {
      if (!snapshot?.settled) return;
      unsubscribe();
      values.clear();
      details = { skipped: [], unreadable: [] };
      inputs = [];
      publish();
    },
  };
}
const sessions = new WeakMap<QueryClient, ReturnType<typeof createSession>>();
export function useVaultImport() {
  const queries = useQueryClient();
  let session = sessions.get(queries);
  if (!session) {
    session = createSession(queries);
    sessions.set(queries, session);
  }
  const run = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return {
    run,
    start: session.start,
    retryFailed: session.retryFailed,
    dismiss: session.dismiss,
  };
}
