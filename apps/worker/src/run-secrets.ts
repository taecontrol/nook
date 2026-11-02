import { D1Client } from '@effect/sql-d1';
import {
  type AskFirstMark,
  canRead,
  coveringMark,
  InvalidRun,
  type RunSecrets,
  SecretKeyUnavailable,
  SecretNotFound,
  SecretsForbidden,
  splitSecretPath,
  VaultNotConfigured,
  validateRunSecrets,
} from '@nook/contract';
import { Effect, Schema } from 'effect';
import { HttpApiError } from 'effect/http-api';
import {
  decideValues,
  ownTerminal,
  type ValuesDecision,
} from './approval-decision.ts';
import {
  attemptRead,
  machineApprovals,
  pendingAnswer,
  readAttempt,
} from './approvals.ts';
import { marksRead, marksUnchanged } from './ask-first.ts';
import { type AuditMachine, approvalEventInsert, auditStore } from './audit.ts';
import { unavailable } from './http-errors.ts';
import { open, parseKeyring } from './vault-keyring.ts';

const Envelope = Schema.Struct({
  key_id: Schema.String,
  iv: Schema.String,
  ciphertext: Schema.String,
});
type RunMachine = AuditMachine & { grantJson: string };
export function runSecrets(
  machine: RunMachine,
  input: RunSecrets,
  binding: string,
  request: { origin: string; client: string | null },
) {
  return Effect.gen(function* () {
    const invalid = validateRunSecrets(input);
    if (invalid)
      return yield* Effect.fail(new InvalidRun({ message: invalid }));
    const paths = [...new Set(input.secrets)];
    yield* authorize(machine, input, paths);
    const sql = yield* D1Client.D1Client;
    const read = yield* sql
      .batch([
        ...paths.map((path) => {
          const { bucket, name } = splitSecretPath(path);
          return sql`SELECT key_id,iv,ciphertext FROM secrets WHERE bucket=${bucket} AND name=${name}`;
        }),
        marksRead(sql),
        ...(input.approval
          ? [attemptRead(sql, machine.id, input.approval.attemptId)]
          : []),
      ])
      .pipe(unavailable);
    const rows = read.slice(0, paths.length);
    const missing = paths.filter((_, index) => rows[index].length === 0);
    if (missing.length)
      return yield* Effect.fail(
        new SecretNotFound({
          message: missing.map((p) => `${p} was not found.`).join(' '),
        }),
      );
    const marks = read[paths.length] as readonly AskFirstMark[];
    const secrets = paths.map((path) => ({
      path,
      coveredBy: coveringMark(marks, path),
    }));
    const covered = secrets.filter((s) => s.coveredBy).map((s) => s.path);
    const own = input.approval
      ? yield* readAttempt(read[paths.length + 1])
      : undefined;
    if (own) {
      const terminal = ownTerminal(own, input);
      if (terminal) return yield* Effect.fail(terminal);
    }
    const approvals = yield* machineApprovals;
    const decision = yield* valuesDecision(
      machine,
      input,
      secrets,
      covered,
      request,
    );
    if (decision?.kind === 'pending') return decision.answer;
    const values = yield* decrypt(paths, rows, binding);
    const delivered = yield* approvals.deliver({
      machine,
      input,
      paths,
      approval: decision?.approval ?? null,
      guard: marksUnchanged(sql, marks),
      settle: decision?.settle ?? (own?.status === 'pending' ? own.id : null),
    });
    if (!delivered)
      return yield* Effect.fail(new HttpApiError.ServiceUnavailable());
    return { values };
  });
}
function authorize(
  machine: RunMachine,
  input: RunSecrets,
  paths: readonly string[],
) {
  return Effect.gen(function* () {
    const denied = paths.filter(
      (path) => !canRead(machine.grant, splitSecretPath(path).bucket),
    );
    if (!denied.length) return;
    const audit = yield* auditStore;
    yield* audit.record(machine, input, denied, 'denied');
    return yield* Effect.fail(new SecretsForbidden({ paths: denied }));
  });
}
function valuesDecision(
  machine: RunMachine,
  input: RunSecrets,
  secrets: readonly { path: string; coveredBy: AskFirstMark | null }[],
  covered: readonly string[],
  request: { origin: string; client: string | null },
) {
  return Effect.gen(function* () {
    if (!covered.length) return null;
    const sql = yield* D1Client.D1Client;
    if (!input.approval) {
      yield* sql
        .batch([
          approvalEventInsert(
            sql,
            {
              outcome: 'approval_refused',
              machine,
              input,
              paths: covered,
              approval: null,
            },
            sql`1`,
          ),
        ])
        .pipe(unavailable);
      return yield* Effect.fail(
        new VaultNotConfigured({
          message: `${covered.join(', ')} needs the owner's approval, and this nook version cannot ask. Update nook.`,
        }),
      );
    }
    const approvals = yield* machineApprovals;
    const read = yield* approvals.read({
      machineId: machine.id,
      attemptId: input.approval.attemptId,
    });
    let decision = decideValues({ ...read, covered, payload: input });
    let now = read.now;
    if (decision.kind === 'create') {
      const created = yield* approvals.create({
        machine,
        input,
        secrets,
        covered,
        attemptId: input.approval.attemptId,
        client: request.client,
      });
      now = created.now;
      decision = decideValues({
        now,
        own: created.row,
        remembered: [],
        covered,
        payload: input,
      });
    }
    return yield* decisionResult(decision, now, request.origin);
  });
}
function decisionResult(decision: ValuesDecision, now: number, origin: string) {
  if (decision.kind === 'refuse') return Effect.fail(decision.error);
  if (decision.kind === 'pending')
    return Effect.succeed({
      kind: 'pending' as const,
      answer: pendingAnswer(decision.request, now, origin),
    });
  if (decision.kind === 'deliver') return Effect.succeed(decision);
  return Effect.fail(new HttpApiError.ServiceUnavailable());
}
function decrypt(
  paths: string[],
  rows: readonly (readonly unknown[])[],
  binding: string,
) {
  return Effect.gen(function* () {
    const ring = yield* parseKeyring(binding);
    return yield* Effect.forEach(paths, (path, index) =>
      Effect.gen(function* () {
        const envelope = yield* Schema.decodeUnknownEffect(Envelope)(
          rows[index][0],
        ).pipe(unavailable);
        const value = yield* open(ring, path, envelope).pipe(
          Effect.mapError(
            () =>
              new SecretKeyUnavailable({
                message: `Cannot open a secret encrypted with key ${envelope.key_id}.`,
              }),
          ),
        );
        return { path, value };
      }),
    );
  });
}
