import { D1Client } from '@effect/sql-d1';
import {
  ApprovalLimit,
  type ApprovalReference,
  type ApprovalView,
  AskFirstMark,
  ApprovalRemember as Remember,
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
import {
  type AuditMachine,
  approvalEventInsert,
  claimColumns,
  useInsert,
} from './audit.ts';
import { unavailable } from './http-errors.ts';

const rowFacts = {
  id: Schema.String,
  machine_id: Schema.String,
  machine_name: Schema.String,
  attempt_id: Schema.String,
  agent: Schema.NullOr(Schema.String),
  agent_session: Schema.NullOr(Schema.String),
  agent_thread: Schema.NullOr(Schema.String),
  secrets_json: Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        coveredBy: Schema.NullOr(AskFirstMark),
      }),
    ),
  ),
  covered_json: Schema.fromJsonString(Schema.Array(Schema.String)),
  purpose: Schema.String,
  working_directory: Schema.String,
  executable: Schema.String,
  client: Schema.NullOr(Schema.String),
  requested_at: Schema.Number,
  expires_at: Schema.Number,
};
const StoredRequest = Schema.Union([
  Schema.Struct({
    ...rowFacts,
    status: Schema.Literal('pending'),
    remember: Schema.Null,
    decided_at: Schema.Null,
    valid_until: Schema.Null,
  }),
  Schema.Struct({
    ...rowFacts,
    status: Schema.Literal('approved'),
    remember: Remember,
    decided_at: Schema.Number,
    valid_until: Schema.Number,
  }),
  Schema.Struct({
    ...rowFacts,
    status: Schema.Literal('denied'),
    remember: Schema.Null,
    decided_at: Schema.Number,
    valid_until: Schema.Null,
  }),
  Schema.Struct({
    ...rowFacts,
    status: Schema.Literals(['withdrawn', 'settled']),
    remember: Schema.Null,
    decided_at: Schema.Null,
    valid_until: Schema.Null,
  }),
]);
export type StoredRequest = typeof StoredRequest.Type;
const StoredApproved = Schema.Struct({
  id: Schema.String,
  machine_id: Schema.String,
  status: Schema.Literal('approved'),
  remember: Remember,
  decided_at: Schema.Number,
  valid_until: Schema.Number,
  covered_json: rowFacts.covered_json,
});
export type StoredApproved = typeof StoredApproved.Type;
export type OwnerFacts = { ip: string | null; country: string | null };
export function ownerFacts(request: Request): OwnerFacts {
  return {
    ip: request.headers.get('CF-Connecting-IP') || null,
    country:
      (request as Request & { cf?: { country?: string } }).cf?.country || null,
  };
}
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(StoredRequest));
function decodeRead(rows: readonly unknown[]) {
  return decodeRows(rows).pipe(unavailable);
}
// A retry must remain bound to its original payload even after its last mark is removed.
// Join this indexed lookup to the existing ciphertext/marks batch; it adds no round trip.
export function attemptRead(
  sql: D1Client.D1Client,
  machineId: string,
  attemptId: string,
) {
  return sql`SELECT * FROM approval_requests WHERE machine_id=${machineId} AND attempt_id=${attemptId}`;
}
export function readAttempt(rows: readonly unknown[]) {
  return decodeRead(rows).pipe(Effect.map((decoded) => decoded[0]));
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
export type Delivery = {
  machine: AuditMachine & { grantJson: string };
  input: RunSecrets;
  paths: readonly string[];
  approval: ApprovalReference | null;
  guard: Fragment;
  settle: string | null;
};
export const machineApprovals = Effect.gen(function* () {
  const sql = yield* D1Client.D1Client;
  return {
    read: (key: { machineId: string; attemptId: string }) =>
      Effect.gen(function* () {
        const [clock, own, remembered] = yield* sql
          .batch([
            sql<{ now: number }>`SELECT unixepoch('subsec')*1000 AS now`,
            sql`SELECT * FROM approval_requests WHERE machine_id=${key.machineId} AND attempt_id=${key.attemptId}`,
            sql`SELECT id,machine_id,status,remember,decided_at,valid_until,covered_json FROM approval_requests WHERE machine_id=${key.machineId} AND status='approved' AND remember<>'once' AND valid_until>unixepoch('subsec')*1000 ORDER BY valid_until DESC,id`,
          ])
          .pipe(unavailable);
        return {
          now: clock[0].now,
          own: (yield* decodeRead(own))[0],
          remembered: yield* Schema.decodeUnknownEffect(
            Schema.Array(StoredApproved),
          )(remembered).pipe(unavailable),
        };
      }),
    create: (request: {
      machine: AuditMachine;
      input: RunSecrets;
      secrets: readonly {
        path: string;
        coveredBy: typeof AskFirstMark.Type | null;
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
            sql`DELETE FROM approval_requests WHERE max(expires_at,coalesce(valid_until,0))<unixepoch('subsec')*1000-86400000`,
            sql`INSERT INTO approval_requests(id,machine_id,machine_name,attempt_id,agent,agent_session,agent_thread,secrets_json,covered_json,purpose,working_directory,executable,client) SELECT ${id},${request.machine.id},${request.machine.machine},${request.attemptId},${claim.agent},${claim.agent_session},${claim.agent_thread},${JSON.stringify(request.secrets)},${JSON.stringify(request.covered)},${request.input.purpose},${request.input.workingDirectory},${request.input.executable},${request.client} WHERE (SELECT count(*) FROM approval_requests WHERE status='pending' AND expires_at>unixepoch('subsec')*1000 AND machine_id=${request.machine.id})<5 AND (SELECT count(*) FROM approval_requests WHERE status='pending' AND expires_at>unixepoch('subsec')*1000)<50 ON CONFLICT(machine_id,attempt_id) DO NOTHING`,
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
            sql`SELECT * FROM approval_requests WHERE machine_id=${request.machine.id} AND attempt_id=${request.attemptId}`,
            sql<{ now: number }>`SELECT unixepoch('subsec')*1000 AS now`,
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
      const { machine, input, paths, approval, guard, settle } = delivery;
      const approvalGuard = approval
        ? sql`EXISTS(SELECT 1 FROM approval_requests a WHERE a.id=${approval.id} AND a.machine_id=${machine.id} AND a.status='approved' AND a.remember=${approval.remember} AND a.valid_until>unixepoch('subsec')*1000)`
        : sql`1`;
      const attemptAllowed = input.approval
        ? sql`NOT EXISTS(SELECT 1 FROM approval_requests WHERE machine_id=${machine.id} AND attempt_id=${input.approval.attemptId} AND status='denied')`
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
          sql`UPDATE approval_requests SET status='withdrawn' WHERE id=${id} AND machine_id=${machineId} AND status='pending' AND expires_at>unixepoch('subsec')*1000`,
          requestEvent(sql, id, 'approval_withdrawn', sql`changes()=1`),
        ])
        .pipe(unavailable, Effect.asVoid),
  };
});
function requestEvent(
  sql: D1Client.D1Client,
  id: string,
  outcome: 'approval_granted' | 'approval_denied' | 'approval_withdrawn',
  guard: Fragment,
  facts: OwnerFacts = { ip: null, country: null },
) {
  return sql`INSERT INTO audit_entries(id,at,outcome,path,bucket,purpose,machine_id,machine_name,working_directory,executable,run_id,approval_id,approval_remember,ip,country) SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-8' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),strftime('%Y-%m-%dT%H:%M:%fZ','now'),${outcome},p.value,substr(p.value,1,length(p.value)-length(json_extract('["' || replace(p.value,'/','","') || '"]','$[#-1]'))-1),a.purpose,a.machine_id,a.machine_name,a.working_directory,a.executable,a.id,a.id,a.remember,${facts.ip},${facts.country} FROM approval_requests a,json_each(a.covered_json) p WHERE a.id=${id} AND (${guard})`;
}
export const ownerApprovals = Effect.gen(function* () {
  const sql = yield* D1Client.D1Client;
  const getRows = (id: string) =>
    sql`SELECT * FROM approval_requests WHERE id=${id}`;
  const readView = (id: string) =>
    Effect.gen(function* () {
      const [rows, clock] = yield* sql
        .batch([
          getRows(id),
          sql<{ now: number }>`SELECT unixepoch('subsec')*1000 AS now`,
        ])
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
            sql`SELECT * FROM approval_requests WHERE status='pending' AND expires_at>unixepoch('subsec')*1000 ORDER BY requested_at,id`,
            sql`SELECT * FROM approval_requests WHERE status='approved' AND remember<>'once' AND valid_until>unixepoch('subsec')*1000 ORDER BY valid_until,id`,
            sql<{ now: number }>`SELECT unixepoch('subsec')*1000 AS now`,
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
            sql`UPDATE approval_requests SET status=${choice.kind === 'approve' ? 'approved' : 'denied'},remember=${remember},decided_at=unixepoch('subsec')*1000,valid_until=CASE WHEN ${window} IS NULL THEN NULL ELSE unixepoch('subsec')*1000+${window} END WHERE id=${id} AND status='pending' AND expires_at>unixepoch('subsec')*1000 RETURNING id`,
            requestEvent(
              sql,
              id,
              choice.kind === 'approve'
                ? 'approval_granted'
                : 'approval_denied',
              sql`changes()=1`,
              facts,
            ),
            getRows(id),
            sql<{ now: number }>`SELECT unixepoch('subsec')*1000 AS now`,
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
        if (!row) return yield* Effect.fail(new HttpApiError.NotFound());
        return toView(row, clock[0].now);
      }),
  };
});
