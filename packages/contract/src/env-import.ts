import { Redacted } from 'effect';
import {
  type SecretValueIssue,
  secretValueIssue,
  validateSecretName,
} from './vault.ts';

export type EnvEntry = {
  line: number;
  name: string;
  value: Redacted.Redacted<string>;
};
export type ParsedEnv = {
  entries: readonly EnvEntry[];
  unreadable: readonly number[];
};

// The dotenv assignment grammar also accepts names that review will reject.
const assignment =
  /^\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?$/dgm;

function parsedValue(raw = '') {
  const trimmed = raw.trim();
  const value = trimmed.replace(/^(['"`])([\s\S]*)\1$/m, '$2');
  return Redacted.make(
    trimmed.startsWith('"')
      ? value.replace(/\\n/g, '\n').replace(/\\r/g, '\r')
      : value,
  );
}
function lineAt(text: string, offset: number) {
  return text.slice(0, offset).split('\n').length;
}
function unreadLines(text: string, read: ReadonlySet<number>) {
  return text.split('\n').flatMap((line, index) => {
    if (
      read.has(index + 1) ||
      line.trim() === '' ||
      line.trimStart().startsWith('#')
    )
      return [];
    return [index + 1];
  });
}
export function parseEnv(text: string): ParsedEnv {
  const normalized = text.replace(/\r\n?/g, '\n');
  const entries: EnvEntry[] = [];
  const read = new Set<number>();
  for (const match of normalized.matchAll(assignment)) {
    const line = lineAt(normalized, match.indices?.[1]?.[0] ?? match.index);
    const last = lineAt(normalized, match.index + match[0].trimEnd().length);
    for (let current = line; current <= last; current++) read.add(current);
    entries.push({ line, name: match[1], value: parsedValue(match[2]) });
  }
  return { entries, unreadable: unreadLines(normalized, read) };
}

export const IMPORT_KEYS_MAX = 100;
export type EnvKeyStatus =
  | 'ready'
  | 'exists'
  | 'invalid-name'
  | 'duplicate'
  | SecretValueIssue;
type ImportKey = {
  name: string;
  value: Redacted.Redacted<string>;
  counted: boolean;
};

function keyStatus(
  key: ImportKey,
  existing: ReadonlySet<string>,
  counts: ReadonlyMap<string, number>,
): EnvKeyStatus {
  const issue = secretValueIssue(Redacted.value(key.value));
  if (issue) return issue;
  if (validateSecretName(key.name)) return 'invalid-name';
  if (existing.has(key.name)) return 'exists';
  return (counts.get(key.name) ?? 0) > 1 ? 'duplicate' : 'ready';
}
export function envKeyStatuses(
  keys: readonly ImportKey[],
  existing: ReadonlySet<string>,
): EnvKeyStatus[] {
  const counts = new Map<string, number>();
  for (const key of keys) {
    if (key.counted) counts.set(key.name, (counts.get(key.name) ?? 0) + 1);
  }
  return keys.map((key) => keyStatus(key, existing, counts));
}
