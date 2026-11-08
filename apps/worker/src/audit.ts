import { D1Client } from '@effect/sql-d1';
import {
  type AgentSessionClaim,
  type ApprovalAuditEntry,
  ApprovalAuditOutcome,
  type ApprovalReference,
  type AuditEntry,
  type AuditFilters,
  type BucketGrant,
  type FileAuditEntry,
  FileAuditOutcome,
  InvalidAuditFilter,
  isClaimValue,
  type MemoryClient,
  normalizeAgentSession,
  type Principal,
  ApprovalRemember as Remember,
  type RunSecrets,
  splitSecretPath,
  validateBucketPath,
  validateSecretPath,
} from '@nook/contract';
import { Effect, Schema } from 'effect';
import type { Fragment } from 'effect/sql/Statement';
import { unavailable } from './http-errors.ts';
import { type OwnerFacts, requireOwner } from './owner-request.ts';

export type AuditMachine = { id: string; machine: string; grant: BucketGrant };
const Facts = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  path: Schema.String,
  purpose: Schema.String,
});
const MachineFacts = Facts.mapFields((fields) => ({
  ...fields,
  machine_id: Schema.String,
  machine_name: Schema.String,
  working_directory: Schema.String,
  agent: Schema.NullOr(Schema.String),
  agent_session: Schema.NullOr(Schema.String),
  agent_thread: Schema.NullOr(Schema.String),
}));
const Row = Schema.Union([
  MachineFacts.mapFields((fields) => ({
    ...fields,
    outcome: Schema.Literals(['delivered', 'denied']),
    executable: Schema.String,
    run_id: Schema.String,
    approval_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
    approval_remember: Schema.optionalKey(Schema.NullOr(Remember)),
  })),
  MachineFacts.mapFields((fields) => ({
    ...fields,
    outcome: Schema.Literal('created'),
    executable: Schema.Null,
    run_id: Schema.Null,
  })),
  Facts.mapFields((fields) => ({
    ...fields,
    outcome: Schema.Literal('revealed'),
    ip: Schema.NullOr(Schema.String),
    country: Schema.NullOr(Schema.String),
    machine_id: Schema.Null,
    machine_name: Schema.Null,
    working_directory: Schema.Null,
    executable: Schema.Null,
    run_id: Schema.Null,
  })),
]);
type Row = typeof Row.Type;
const FileRow = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  outcome: FileAuditOutcome,
  bucket: Schema.String,
  memory_id: Schema.String,
  file_name: Schema.String,
  file_size: Schema.Number,
  file_sha256: Schema.String,
  replaced_sha256: Schema.NullOr(Schema.String),
  client_name: Schema.String,
  client_version: Schema.NullOr(Schema.String),
  machine_id: Schema.NullOr(Schema.String),
  machine_name: Schema.NullOr(Schema.String),
  ip: Schema.NullOr(Schema.String),
  country: Schema.NullOr(Schema.String),
});
function fileEntry(row: typeof FileRow.Type): FileAuditEntry {
  return {
    id: row.id,
    at: row.at,
    outcome: row.outcome,
    bucket: row.bucket,
    memoryId: row.memory_id,
    name: row.file_name,
    size: row.file_size,
    sha256: row.file_sha256,
    replacedSha256: row.replaced_sha256,
    principal:
      row.machine_id !== null && row.machine_name !== null
        ? { kind: 'machine', id: row.machine_id, name: row.machine_name }
        : { kind: 'owner' },
    client: { name: row.client_name, version: row.client_version },
    ip: row.ip,
    country: row.country,
  };
}
const ApprovalRow = MachineFacts.mapFields((fields) => ({
  ...fields,
  outcome: ApprovalAuditOutcome,
  executable: Schema.String,
  run_id: Schema.String,
  approval_id: Schema.NullOr(Schema.String),
  approval_remember: Schema.NullOr(Remember),
  ip: Schema.NullOr(Schema.String),
  country: Schema.NullOr(Schema.String),
}));
const AnyRow = Schema.Union([Row, FileRow, ApprovalRow]);
function anyEntry(row: typeof AnyRow.Type): AuditEntry {
  if ('file_name' in row) return fileEntry(row);
  return 'ip' in row && row.outcome !== 'revealed'
    ? approvalEntry(row)
    : entry(row);
}

export type FileActor = {
  principal: Principal;
  client: MemoryClient;
} & Partial<OwnerFacts>;
export function ownerFileActor(
  client: MemoryClient = { name: 'unknown', version: null },
  facts: Partial<OwnerFacts> = {},
): FileActor {
  return { principal: { kind: 'owner' }, client, ...facts };
}
export function machineFileActor(
  machine: { id: string; name: string },
  client: MemoryClient,
): FileActor {
  return {
    principal: { kind: 'machine', id: machine.id, name: machine.name },
    client,
  };
}
// A selection can contain many forgotten files. Generate an independent v4 id
// per selected row inside D1, keeping every audit write in the caller's batch.
export function fileAuditInsert(
  sql: D1Client.D1Client,
  actor: FileActor,
  selection: Fragment,
) {
  const machine = actor.principal.kind === 'machine' ? actor.principal : null;
  const ip = machine ? null : (actor.ip ?? null);
  const country = machine ? null : (actor.country ?? null);
  const id = sql`lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random())%4+1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))`;
  return sql<{
    id: string;
  }>`INSERT INTO audit_entries(id,at,outcome,bucket,memory_id,file_name,file_size,file_sha256,replaced_sha256,machine_id,machine_name,client_name,client_version,ip,country) SELECT ${id},${new Date().toISOString()},f.outcome,f.bucket,f.memory_id,f.name,f.size,f.sha256,f.replaced_sha256,${machine?.id ?? null},${machine?.name ?? null},${actor.client.name},${actor.client.version},${ip},${country} FROM (${selection}) f RETURNING id`;
}
function entry(row: Row): AuditEntry {
  const facts = {
    id: row.id,
    at: row.at,
    path: row.path,
    ...splitSecretPath(row.path),
    purpose: row.purpose,
  };
  if (row.outcome === 'revealed')
    return { ...facts, outcome: row.outcome, ip: row.ip, country: row.country };
  const machineFacts = {
    ...facts,
    machine: { id: row.machine_id, name: row.machine_name },
    workingDirectory: row.working_directory,
    agentSession:
      row.agent !== null && row.agent_session !== null
        ? {
            agent: row.agent,
            session: row.agent_session,
            ...(row.agent_thread !== null ? { thread: row.agent_thread } : {}),
          }
        : null,
  };
  return row.outcome === 'created'
    ? { ...machineFacts, outcome: row.outcome }
    : {
        ...machineFacts,
        outcome: row.outcome,
        executable: row.executable,
        runId: row.run_id,
        ...(row.approval_id && row.approval_remember
          ? {
              approval: {
                id: row.approval_id,
                remember: row.approval_remember,
              },
            }
          : {}),
      };
}
function approvalEntry(row: typeof ApprovalRow.Type): ApprovalAuditEntry {
  return {
    id: row.id,
    at: row.at,
    path: row.path,
    ...splitSecretPath(row.path),
    purpose: row.purpose,
    machine: { id: row.machine_id, name: row.machine_name },
    workingDirectory: row.working_directory,
    agentSession: null,
    outcome: row.outcome,
    executable: row.executable,
    runId: row.run_id,
    approval: row.approval_id
      ? { id: row.approval_id, remember: row.approval_remember }
      : null,
    ip: row.ip,
    country: row.country,
  };
}
function randomId(sql: D1Client.D1Client) {
  return sql`lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-8' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))`;
}
function pathBucket(sql: D1Client.D1Client) {
  return sql`substr(p.value,1,length(p.value)-length(json_extract('["' || replace(p.value,'/','","') || '"]','$[#-1]'))-1)`;
}
export function useInsert(
  sql: D1Client.D1Client,
  machine: AuditMachine,
  input: RunSecrets,
  paths: readonly string[],
  approval: ApprovalReference | null,
  guard: Fragment,
) {
  const claim = claimColumns(input.agentSession);
  return sql<{
    id: string;
  }>`INSERT INTO audit_entries(id,at,outcome,path,bucket,purpose,machine_id,machine_name,working_directory,executable,run_id,agent,agent_session,agent_thread,approval_id,approval_remember) SELECT ${randomId(sql)},${new Date().toISOString()},'delivered',p.value,${pathBucket(sql)},${input.purpose},${machine.id},${machine.machine},${input.workingDirectory},${input.executable},${crypto.randomUUID()},${claim.agent},${claim.agent_session},${claim.agent_thread},${approval?.id ?? null},${approval?.remember ?? null} FROM json_each(${JSON.stringify(paths)}) p WHERE ${guard} RETURNING id`;
}
export function approvalEventInsert(
  sql: D1Client.D1Client,
  event: {
    outcome: 'approval_requested' | 'approval_refused';
    machine: AuditMachine;
    input: RunSecrets;
    paths: readonly string[];
    approval: { id: string; remember: null } | null;
  },
  guard: Fragment,
) {
  return sql`INSERT INTO audit_entries(id,at,outcome,path,bucket,purpose,machine_id,machine_name,working_directory,executable,run_id,approval_id) SELECT ${randomId(sql)},${new Date().toISOString()},${event.outcome},p.value,${pathBucket(sql)},${event.input.purpose},${event.machine.id},${event.machine.machine},${event.input.workingDirectory},${event.input.executable},${crypto.randomUUID()},${event.approval?.id ?? null} FROM json_each(${JSON.stringify(event.paths)}) p WHERE ${guard}`;
}
export function requestApprovalEventInsert(
  sql: D1Client.D1Client,
  id: string,
  outcome: 'approval_granted' | 'approval_denied' | 'approval_withdrawn',
  guard: Fragment,
  facts: OwnerFacts = {
    ip: null,
    country: null,
  },
) {
  return sql`INSERT INTO audit_entries(id,at,outcome,path,bucket,purpose,machine_id,machine_name,working_directory,executable,run_id,approval_id,approval_remember,ip,country) SELECT ${randomId(sql)},strftime('%Y-%m-%dT%H:%M:%fZ','now'),${outcome},p.value,${pathBucket(sql)},a.purpose,a.machine_id,a.machine_name,a.working_directory,a.executable,a.id,a.id,a.remember,${facts.ip},${facts.country} FROM approval_requests a,json_each(a.covered_json) p WHERE a.id=${id} AND (${guard})`;
}

function encodeCursor(row: { at: string; id: string }) {
  return btoa(JSON.stringify({ at: row.at, id: row.id }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
function decodeCursor(cursor?: string) {
  if (!cursor) return undefined;
  const decoded = JSON.parse(
    atob(cursor.replaceAll('-', '+').replaceAll('_', '/')),
  ) as { at: string; id: string };
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      decoded.id,
    ) ||
    new Date(decoded.at).toISOString() !== decoded.at ||
    encodeCursor(decoded) !== cursor
  )
    throw new InvalidAuditFilter();
  return decoded;
}
function invalidFilters(input: AuditFilters) {
  return (
    (input.bucket && validateBucketPath(input.bucket)) ||
    (input.secret && validateSecretPath(input.secret)) ||
    (input.session !== undefined && !isClaimValue(input.session))
  );
}
function filters(input: AuditFilters) {
  return Effect.try({
    try: () => {
      if (invalidFilters(input)) throw new InvalidAuditFilter();
      return {
        bucket: input.bucket ?? '',
        secret: input.secret ?? '',
        session: input.session,
        cursor: decodeCursor(input.cursor),
      };
    },
    catch: () => new InvalidAuditFilter(),
  });
}
export function claimColumns(claim: AgentSessionClaim | undefined) {
  const normalized = normalizeAgentSession(claim);
  return {
    agent: normalized?.agent ?? null,
    agent_session: normalized?.session ?? null,
    agent_thread: normalized?.thread ?? null,
  };
}
export const auditStore = Effect.gen(function* () {
  const sql = yield* D1Client.D1Client;
  return {
    recordReveal: (path: string, facts: OwnerFacts) =>
      sql`INSERT INTO audit_entries(id, at, outcome, path, bucket, purpose, ip, country) VALUES (${crypto.randomUUID()}, ${new Date().toISOString()}, 'revealed', ${path}, ${splitSecretPath(path).bucket}, 'Revealed in web app', ${facts.ip}, ${facts.country})`.pipe(
        unavailable,
        Effect.asVoid,
      ),
    record: (
      machine: AuditMachine,
      input: RunSecrets,
      paths: readonly string[],
      outcome: 'delivered' | 'denied',
    ) => {
      const run = crypto.randomUUID();
      const at = new Date().toISOString();
      const claim = claimColumns(input.agentSession);
      return sql
        .batch(
          paths.map(
            (path) =>
              sql`INSERT INTO audit_entries(id, at, outcome, path, bucket, purpose, machine_id, machine_name, working_directory, executable, run_id, agent, agent_session, agent_thread) VALUES (${crypto.randomUUID()}, ${at}, ${outcome}, ${path}, ${splitSecretPath(path).bucket}, ${input.purpose}, ${machine.id}, ${machine.machine}, ${input.workingDirectory}, ${input.executable}, ${run}, ${claim.agent}, ${claim.agent_session}, ${claim.agent_thread})`,
          ),
        )
        .pipe(unavailable, Effect.asVoid);
    },
    list: (grant: BucketGrant, input: AuditFilters) =>
      Effect.gen(function* () {
        yield* requireOwner(grant);
        const { bucket, secret, session, cursor } = yield* filters(input);
        const boundary = cursor
          ? sql`(at < ${cursor.at} OR (at = ${cursor.at} AND id < ${cursor.id}))`
          : sql`1`;
        const sessionFilter =
          session !== undefined ? sql`agent_session = ${session}` : sql`1`;
        const rows =
          yield* sql`SELECT * FROM audit_entries WHERE (${bucket} = '' OR bucket=${bucket} OR bucket LIKE ${`${bucket}/%`}) AND (${secret} = '' OR path = ${secret}) AND ${sessionFilter} AND ${boundary} ORDER BY at DESC, id DESC LIMIT 26`.pipe(
            unavailable,
          );
        const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(AnyRow))(
          rows,
        ).pipe(unavailable);
        const page = decoded.slice(0, 25);
        return {
          entries: page.map(anyEntry),
          next: decoded.length > 25 ? encodeCursor(page[24]) : null,
        };
      }),
  };
});
