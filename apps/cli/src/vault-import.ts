import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  type CreateMachineSecret,
  type EnvEntry,
  type EnvKeyStatus,
  envKeyStatuses,
  IMPORT_KEYS_MAX,
  parseEnv,
  type SecretValueIssue,
  validateSecretName,
  validateWorkingDirectory,
} from '@nook/contract';
import { Effect } from 'effect';
import { resolveAgentSession } from './agent-session.ts';
import { CliFailure, type RequestFailure, tryCli } from './errors.ts';
import type { Host } from './host.ts';
import { currentDirectory } from './project-secrets.ts';
import {
  type CreateOutcome,
  createSecretOnce,
  createSession,
} from './secret-write.ts';
import { parseImport } from './vault-import-arguments.ts';

type KeyResult =
  | { status: 'created' | 'exists' | 'not tried' }
  | { status: 'skipped' | 'failed' | 'unconfirmed'; reason: string };
export type ImportedKey = { line: number; name: string; result: KeyResult };
type Request = Effect.Success<ReturnType<typeof createSession>>['request'];
const valueReasons: Record<SecretValueIssue, string> = {
  empty: 'empty value',
  'too-long': 'value over 64 KiB',
  nul: 'value contains NUL',
  unicode: 'value is not valid Unicode',
};
function readEnv(file: string) {
  return Effect.gen(function* () {
    const bytes = yield* Effect.tryPromise({
      try: () => readFile(file),
      catch: () => new CliFailure(`Could not read ${file}.`),
    });
    const text = yield* Effect.try({
      try: () => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      catch: () => new CliFailure(`${file} is not valid UTF-8.`),
    });
    const parsed = parseEnv(text);
    if (parsed.entries.length === 0)
      return yield* Effect.fail(new CliFailure(`No keys found in ${file}.`));
    if (parsed.entries.length > IMPORT_KEYS_MAX)
      return yield* Effect.fail(
        new CliFailure(
          `${file} has ${parsed.entries.length} keys; import at most ${IMPORT_KEYS_MAX} at a time.`,
        ),
      );
    return parsed;
  });
}
function listingFailure(error: RequestFailure, bucket: string) {
  if (error.server.tag === 'Forbidden')
    return new CliFailure(`Access to ${bucket} is forbidden.`);
  if (error.server.tag === 'BucketNotFound')
    return new CliFailure('Bucket not found.');
  return error;
}
function fixReason(entry: EnvEntry, status: EnvKeyStatus) {
  if (status === 'invalid-name') return validateSecretName(entry.name);
  if (status === 'duplicate') return 'duplicate';
}
function requireFixes(
  entries: readonly EnvEntry[],
  statuses: readonly EnvKeyStatus[],
  file: string,
) {
  const problems = entries.flatMap((entry, index) => {
    const reason = fixReason(entry, statuses[index]);
    return reason ? [`line ${entry.line}  ${entry.name}  ${reason}`] : [];
  });
  if (problems.length)
    throw new CliFailure(
      `Nothing was imported. Fix these keys in ${file} and run again:\n${problems.join('\n')}`,
    );
}
function initialResult(status: EnvKeyStatus): KeyResult {
  if (status === 'exists') return { status: 'exists' };
  if (Object.hasOwn(valueReasons, status))
    return {
      status: 'skipped',
      reason: valueReasons[status as SecretValueIssue],
    };
  return { status: 'not tried' };
}
function keyResult(outcome: CreateOutcome): KeyResult {
  switch (outcome._tag) {
    case 'Created':
      return { status: 'created' };
    case 'Exists':
      return { status: 'exists' };
    case 'Refused':
      return { status: 'failed', reason: outcome.message };
    case 'Unconfirmed':
      return {
        status: 'unconfirmed',
        reason: 'could not confirm whether it was stored; run again to check',
      };
  }
}
export function writeKeys(
  request: Request,
  entries: readonly EnvEntry[],
  keys: ImportedKey[],
  input: Pick<
    CreateMachineSecret,
    'bucket' | 'purpose' | 'workingDirectory' | 'agentSession'
  >,
) {
  let stopped = false;
  return Effect.forEach(
    entries,
    (entry, index) =>
      Effect.gen(function* () {
        if (stopped || keys[index].result.status !== 'not tried') return;
        const outcome = yield* createSecretOnce(
          request,
          {
            ...input,
            name: entry.name,
            value: entry.value,
            description: '',
            writeId: randomUUID(),
          },
          input.bucket,
        );
        keys[index].result = keyResult(outcome);
        if (outcome._tag === 'Refused' && outcome.bucketWide) stopped = true;
      }),
    { concurrency: 3, discard: true },
  );
}
function summary(keys: readonly ImportedKey[]) {
  const labels: [KeyResult['status'], string][] = [
    ['created', 'created'],
    ['exists', 'already existed'],
    ['skipped', 'skipped'],
    ['failed', 'failed'],
    ['unconfirmed', 'unconfirmed'],
    ['not tried', 'not tried'],
  ];
  return `${labels
    .flatMap(([status, label]) => {
      const count = keys.filter((key) => key.result.status === status).length;
      return count ? [`${count} ${label}`] : [];
    })
    .join(', ')}.`;
}
function keyLine(key: ImportedKey, bucket: string) {
  const { name, result } = key;
  if (result.status === 'exists')
    return `  exists   ${name}  already in ${bucket}; not changed`;
  const reason = 'reason' in result ? `  ${result.reason}` : '';
  return `  ${result.status}  ${name}${reason}`;
}
function report(
  keys: readonly ImportedKey[],
  unreadable: readonly number[],
  bucket: string,
  file: string,
) {
  const lines = [
    `Imported ${file} into ${bucket}.`,
    ...keys.map((key) => keyLine(key, bucket)),
  ];
  if (unreadable.length)
    lines.push(
      `Lines ${unreadable.join(', ')} are not KEY=value; not imported.`,
    );
  lines.push(summary(keys));
  const secrets = Object.fromEntries(
    keys
      .filter(
        (key) =>
          key.result.status === 'created' || key.result.status === 'exists',
      )
      .map((key) => [key.name, `${bucket}/${key.name}`]),
  );
  if (Object.keys(secrets).length)
    lines.push('', 'nook.json:', JSON.stringify({ secrets }, null, 2));
  return lines.join('\n');
}
export function vaultImport(
  host: Host,
  args: readonly string[],
  write: (message: string) => void,
) {
  return Effect.gen(function* () {
    const { bucket, file, purpose } = yield* tryCli(() => parseImport(args));
    const workingDirectory = yield* currentDirectory;
    const message = validateWorkingDirectory(workingDirectory);
    if (message) return yield* Effect.fail(new CliFailure(message));
    const parsed = yield* readEnv(file);
    const agentSession = resolveAgentSession((name) => process.env[name]);
    const { request } = yield* createSession(host);
    const { secrets } = yield* request((api, headers) =>
      api.machine.secrets({ headers, query: { bucket } }),
    ).pipe(Effect.mapError((error) => listingFailure(error, bucket)));
    const existing = new Set(
      secrets
        .filter((secret) => secret.bucket === bucket)
        .map((secret) => secret.name),
    );
    const statuses = envKeyStatuses(
      parsed.entries.map((entry) => ({ ...entry, counted: true })),
      existing,
    );
    yield* tryCli(() => requireFixes(parsed.entries, statuses, file));
    const keys = parsed.entries.map(
      ({ line, name }, index): ImportedKey => ({
        line,
        name,
        result: initialResult(statuses[index]),
      }),
    );
    yield* writeKeys(request, parsed.entries, keys, {
      bucket,
      purpose,
      workingDirectory,
      ...(agentSession ? { agentSession } : {}),
    });
    const output = report(keys, parsed.unreadable, bucket, file);
    if (
      keys.some((key) =>
        ['failed', 'unconfirmed', 'not tried'].includes(key.result.status),
      )
    )
      return yield* Effect.fail(new CliFailure(output));
    write(output);
  });
}
