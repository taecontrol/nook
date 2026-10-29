import {
  secretLimits,
  validateSecretDescription,
  validateSecretName,
} from '@nook/contract';
import { Redacted } from 'effect';
import type { ParsedEnv } from './env-parse';

export const IMPORT_KEYS_MAX = 100;
export type ImportRow = {
  id: string;
  line: number;
  name: string;
  description: string;
  included: boolean;
  value: 'present' | 'empty' | 'too-long';
};
export type RowStatus =
  | 'ready'
  | 'exists'
  | 'invalid-name'
  | 'invalid-description'
  | 'duplicate'
  | 'empty'
  | 'too-long';
export type ImportSelection = readonly {
  row: ImportRow;
  value: Redacted.Redacted<string>;
}[];

export function rowsFrom(
  parsed: ParsedEnv,
): { rows: ImportRow[] } | { tooMany: number } {
  if (parsed.entries.length > IMPORT_KEYS_MAX)
    return { tooMany: parsed.entries.length };
  return {
    rows: parsed.entries.map((entry) => ({
      id: `line-${entry.line}`,
      line: entry.line,
      name: entry.name,
      description: '',
      included: true,
      value: valueStatus(entry.value),
    })),
  };
}
function valueStatus(value: Redacted.Redacted<string>): ImportRow['value'] {
  const text = Redacted.value(value);
  if (text === '') return 'empty';
  return new TextEncoder().encode(text).length > secretLimits.valueBytes
    ? 'too-long'
    : 'present';
}
function baseStatus(row: ImportRow, existing: ReadonlySet<string>): RowStatus {
  if (row.value !== 'present') return row.value;
  if (validateSecretName(row.name)) return 'invalid-name';
  if (validateSecretDescription(row.description)) return 'invalid-description';
  return existing.has(row.name) ? 'exists' : 'ready';
}
export function needsFix(status: RowStatus, included: boolean) {
  return (
    status === 'invalid-name' ||
    status === 'invalid-description' ||
    (status === 'duplicate' && included)
  );
}
function duplicateCounts(
  rows: readonly ImportRow[],
  base: ReadonlyMap<string, RowStatus>,
) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.included && base.get(row.id) === 'ready')
      counts.set(row.name, (counts.get(row.name) ?? 0) + 1);
  }
  return counts;
}
export function review(
  rows: readonly ImportRow[],
  values: ReadonlyMap<string, Redacted.Redacted<string>>,
  existing: ReadonlySet<string>,
): {
  status: ReadonlyMap<string, RowStatus>;
  selection: ImportSelection;
  toFix: number;
} {
  const status = new Map(
    rows.map((row) => [row.id, baseStatus(row, existing)]),
  );
  const counts = duplicateCounts(rows, status);
  const selection: { row: ImportRow; value: Redacted.Redacted<string> }[] = [];
  for (const row of rows) {
    if (
      status.get(row.id) === 'ready' &&
      (counts.get(row.name) ?? 0) > Number(row.included)
    )
      status.set(row.id, 'duplicate');
    const value = values.get(row.id);
    if (row.included && status.get(row.id) === 'ready' && value)
      selection.push({ row, value });
  }
  const toFix = rows.filter((row) =>
    needsFix(status.get(row.id) as RowStatus, row.included),
  ).length;
  return { status, selection, toFix };
}
