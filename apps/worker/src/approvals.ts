import { D1Client } from '@effect/sql-d1';
import {
  ApprovalLimit,
  type ApprovalReference,
  type ApprovalView,
  type AskFirstMark,
  type RunSecrets,
  rememberDuration,
} from '@nook/contract';
import { Effect, Schema } from 'effect';
import { HttpApiError } from 'effect/http-api';
import type { Fragment } from 'effect/sql/Statement';
import {
  decisionOutcome,
  type OwnerChoice,
  viewState,
} from './approval-decision.ts';
import { StoredApproved, StoredRequest } from './approval-rows.ts';
import {
  type AuditMachine,
  approvalEventInsert,
  claimColumns,
  requestApprovalEventInsert,
  useInsert,
} from './audit.ts';
import { unavailable } from './http-errors.ts';
import type { OwnerFacts } from './owner-request.ts';

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(StoredRequest));
function decodeRead(rows: readonly unknown[]) {
  return decodeRows(rows).pipe(unavailable);
}
function now(sql: D1Client.D1Client) {
  return sql`unixepoch('subsec')*1000`;
}
function clockRead(sql: D1Client.D1Client) {
  return sql<{ now: number }>`SELECT ${now(sql)} AS now`;
}
function attemptRow(
  sql: D1Client.D1Client,
  machineId: string,
  attemptId: string,
) {
  return sql`FROM approval_requests WHERE machine_id=${machineId} AND attempt_id=${attemptId}`;
}
function rememberedFor(sql: D1Client.D1Client) {
  return sql`status='approved' AND remember<>'once' AND valid_until>${now(sql)}`;
}
// A retry stays bound to its original payload even after its last mark is removed.
// Read the attempt, clock and remembered approvals in the ciphertext/marks batch.
export function runApprovalReads(
  sql: D1Client.D1Client,
  machineId: string,
  attemptId: string,
) {
  return [
    sql`SELECT * ${attemptRow(sql, machineId, attemptId)}`,
    clockRead(sql),
    sql`SELECT id,machine_id,status,remember,decided_at,valid_until,covered_json FROM approval_requests WHERE machine_id=${machineId} AND ${rememberedFor(sql)} ORDER BY valid_until DESC,id`,
  ] as const;
}
const RunApprovalRead = Schema.Tuple([
  Schema.Array(StoredRequest),
  Schema.Array(Schema.Struct({ now: Schema.Number })),
  Schema.Array(StoredApproved),
]);
export function readRunApprovals(rows: readonly unknown[]) {
  return Schema.decodeUnknownEffect(RunApprovalRead)(rows).pipe(
    unavailable,
    Effect.map(([own, clock, remembered]) => ({
      own: own[0],
      now: clock[0].now,
      remembered,
    })),
  );
}
function toView(row: StoredRequest, now: number): ApprovalView {
  const facts = {
    id: row.id,
    verified: {
      machine: { id: row.machine_id, name: row.machine_name },
      secrets: row.secrets_json,
    },
    claimed: {
      purpose: row.purpose,
      workingDirectory: row.working_directory,
      executable: row.executable,
      session:
        row.agent !== null && row.agent_session !== null
          ? {
              agent: row.agent,
              session: row.agent_session,
              ...(row.agent_thread !== null
                ? { thread: row.agent_thread }
                : {}),
            }
          : null,
      client: row.client,
    },
    requestedAt: new Date(row.requested_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
  if (row.status === 'approved')
    return {
      ...facts,
      state: 'approved',
      remember: row.remember,
      decidedAt: new Date(row.decided_at).toISOString(),
      validUntil: new Date(row.valid_until).toISOString(),
    };
  if (row.status === 'denied')
    return {
      ...facts,
      state: 'denied',
      decidedAt: new Date(row.decided_at).toISOString(),
    };
  return {
    ...facts,
    state: viewState(row, now),
  };
}
export function pendingAnswer(
  row: Extract<StoredRequest, { status: 'pending' }>,
  now: number,
  origin: string,
) {
  return {
    approval: {
      id: row.id,
      url: `${origin}/approvals/${row.id}`,
      paths: row.covered_json,
      expiresAt: new Date(row.expires_at).toISOString(),
      expiresIn: Math.max(0, (row.expires_at - now) / 1000),
      interval: 2,
    },
  };
}
type Delivery = {
  machine: AuditMachine & { grantJson: string };
  input: RunSecrets;
  paths: readonly string[];
  approval: ApprovalReference | null;
  ownRequestId: string | null;
  guard: Fragment;
  settle: string | null;
};
export const machineApprovals = Effect.gen(function* () {
  const sql = yield* D1Client.D1Client;
  return {
    create: (request: {
      machine: AuditMachine;
      input: RunSecrets;
      secrets: readonly {
        path: string;
        coveredBy: AskFirstMark | null;
      }[];
      covered: readonly string[];
      attemptId: string;
      client: string | null;
    }) =>
      Effect.gen(function* () {
        const id = crypto.randomUUID();
        const claim = claimColumns(request.input.agentSession);
        const [, , , rows, clock] = yield* sql
          .batch([
            sql`DELETE FROM approval_requests WHERE max(expires_at,coalesce(valid_until,0))<${now(sql)}-86400000`,
            sql`INSERT INTO approval_requests(id,machine_id,machine_name,attempt_id,agent,agent_session,agent_thread,secrets_json,covered_json,purpose,working_directory,executable,client) SELECT ${id},${request.machine.id},${request.machine.machine},${request.attemptId},${claim.agent},${claim.agent_session},${claim.agent_thread},${JSON.stringify(request.secrets)},${JSON.stringify(request.covered)},${request.input.purpose},${request.input.workingDirectory},${request.input.executable},${request.client} WHERE (SELECT count(*) FROM approval_requests WHERE status='pending' AND expires_at>${now(sql)} AND machine_id=${request.machine.id})<5 AND (SELECT count(*) FROM approval_requests WHERE status='pending' AND expires_at>${now(sql)})<50 ON CONFLICT(machine_id,attempt_id) DO NOTHING`,
            approvalEventInsert(
              sql,
              {
                outcome: 'approval_requested',
                machine: request.machine,
                input: request.input,
                paths: request.covered,
                approval: { id, remember: null },
              },
              sql`EXISTS(SELECT 1 FROM approval_requests WHERE id=${id})`,
            ),
            sql`SELECT * ${attemptRow(sql, request.machine.id, request.attemptId)}`,
            clockRead(sql),
          ])
          .pipe(unavailable);
        const row = (yield* decodeRead(rows))[0];
        if (!row)
          return yield* Effect.fail(
            new ApprovalLimit({
              message:
                'Too many pending approval requests. Wait for one to finish and run again.',
            }),
          );
        return { row, now: clock[0].now };
      }),
    deliver: (delivery: Delivery) => {
      const { machine, input, paths, approval, ownRequestId, guard, settle } =
        delivery;
      const approvalGuard = approval
        ? sql`EXISTS(SELECT 1 FROM approval_requests a WHERE a.id=${approval.id} AND a.machine_id=${machine.id} AND a.status='approved' AND a.remember=${approval.remember} AND a.valid_until>${now(sql)})`
        : sql`1`;
      // Match absence too: a newly created attempt needs payload validation and
      // may need settlement before this run can deliver.
      const attemptAllowed = input.approval
        ? sql`(SELECT id ${attemptRow(sql, machine.id, input.approval.attemptId)}) IS ${ownRequestId} AND NOT EXISTS(SELECT 1 ${attemptRow(sql, machine.id, input.approval.attemptId)} AND status IN ('denied','withdrawn'))`
        : sql`1`;
      const access = sql`(${attemptAllowed}) AND EXISTS(SELECT 1 FROM machine_tokens WHERE id=${machine.id} AND grant_json=${machine.grantJson}) AND (${guard}) AND (${approvalGuard})`;
      const statements = [
        useInsert(sql, machine, input, paths, approval, access),
      ];
      if (settle)
        statements.push(
          sql`UPDATE approval_requests SET status='settled' WHERE id=${settle} AND status='pending' AND changes()=${paths.length} RETURNING id`,
        );
      return sql.batch(statements).pipe(
        unavailable,
        Effect.map(([inserted]) => inserted.length === paths.length),
      );
    },
    withdraw: (machineId: string, id: string) =>
      sql
        .batch([
          sql`UPDATE approval_requests SET status='withdrawn' WHERE id=${id} AND machine_id=${machineId} AND status='pending' AND expires_at>${now(sql)}`,
          requestApprovalEventInsert(
            sql,
            id,
            'approval_withdrawn',
            sql`changes()=1`,
          ),
        ])
        .pipe(unavailable, Effect.asVoid),
  };
});
export const ownerApprovals = Effect.gen(function* () {
  const sql = yield* D1Client.D1Client;
  const getRows = (id: string) =>
    sql`SELECT * FROM approval_requests WHERE id=${id}`;
  const readView = (id: string) =>
    Effect.gen(function* () {
      const [rows, clock] = yield* sql
        .batch([getRows(id), clockRead(sql)])
        .pipe(unavailable);
      const row = (yield* decodeRead(rows))[0];
      if (!row) return yield* Effect.fail(new HttpApiError.NotFound());
      return toView(row, clock[0].now);
    });
  return {
    get: readView,
    list: () =>
      Effect.gen(function* () {
        const [pending, remembered, clock] = yield* sql
          .batch([
            sql`SELECT * FROM approval_requests WHERE status='pending' AND expires_at>${now(sql)} ORDER BY requested_at,id`,
            sql`SELECT * FROM approval_requests WHERE ${rememberedFor(sql)} ORDER BY valid_until,id`,
            clockRead(sql),
          ])
          .pipe(unavailable);
        return {
          pending: (yield* decodeRead(pending)).map((r) =>
            toView(r, clock[0].now),
          ),
          remembered: (yield* decodeRead(remembered)).map((r) =>
            toView(r, clock[0].now),
          ),
        };
      }),
    decide: (id: string, choice: OwnerChoice, facts: OwnerFacts) =>
      Effect.gen(function* () {
        const remember = choice.kind === 'approve' ? choice.remember : null;
        const window = remember ? rememberDuration[remember] : null;
        const [updated, , rows, clock] = yield* sql
          .batch([
            sql`UPDATE approval_requests SET status=${choice.kind === 'approve' ? 'approved' : 'denied'},remember=${remember},decided_at=${now(sql)},valid_until=CASE WHEN ${window} IS NULL THEN NULL ELSE ${now(sql)}+${window} END WHERE id=${id} AND status='pending' AND expires_at>${now(sql)} RETURNING id`,
            requestApprovalEventInsert(
              sql,
              id,
              choice.kind === 'approve'
                ? 'approval_granted'
                : 'approval_denied',
              sql`changes()=1`,
              facts,
            ),
            getRows(id),
            clockRead(sql),
          ])
          .pipe(unavailable);
        const row = (yield* decodeRead(rows))[0];
        const outcome = decisionOutcome(
          choice,
          updated.length === 1,
          row,
          clock[0].now,
        );
        if (outcome.kind === 'fail') return yield* Effect.fail(outcome.error);
        return toView(outcome.row, clock[0].now);
      }),
  };
});
