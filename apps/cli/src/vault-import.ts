import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  type CreateMachineSecret,
  type EnvEntry,
  type EnvKeyStatus,
  envKeyStatuses,
  IMPORT_KEYS_MAX,
  parseEnv,
  RUN_PATHS_MAX,
  type SecretValueIssue,
  validateSecretName,
} from '@nook/contract';
import { Effect } from 'effect';
import { agentSessionContext, isClaimVariable } from './agent-session.ts';
import { CliFailure, tryCli } from './errors.ts';
import type { Host } from './host.ts';
import { writeDirectory } from './project-secrets.ts';
import {
  type CreateOutcome,
  createSecretOnce,
  createSession,
} from './secret-write.ts';
import { listSecrets } from './vault.ts';
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
  const stored = keys
    .filter(
      (key) =>
        key.result.status === 'created' || key.result.status === 'exists',
    )
    .map((key) => key.name);
  // nook run refuses reserved names and more than RUN_PATHS_MAX paths.
  for (const name of stored.filter(isClaimVariable))
    lines.push(
      `${name} is reserved for agent session claims; map it in nook.json under another name.`,
    );
  const mapped = stored.filter((name) => !isClaimVariable(name));
  if (mapped.length > RUN_PATHS_MAX)
    lines.push(
      `nook run uses at most ${RUN_PATHS_MAX} secrets; keep only the ones this project needs.`,
    );
  const secrets = Object.fromEntries(
    mapped.map((name) => [name, `${bucket}/${name}`]),
  );
  if (mapped.length)
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
    const workingDirectory = yield* writeDirectory;
    const parsed = yield* readEnv(file);
    const agentContext = agentSessionContext();
    const { request } = yield* createSession(host);
    const secrets = yield* listSecrets(request, bucket);
    if (typeof secrets === 'string')
      return yield* Effect.fail(
        new CliFailure(
          secrets === 'Forbidden'
            ? `Access to ${bucket} is forbidden.`
            : 'Bucket not found.',
        ),
      );
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
      ...agentContext,
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
