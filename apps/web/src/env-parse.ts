import { Redacted } from 'effect';

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
