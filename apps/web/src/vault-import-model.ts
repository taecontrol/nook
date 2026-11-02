import {
  type EnvKeyStatus,
  envKeyStatuses,
  IMPORT_KEYS_MAX,
  type ParsedEnv,
  type SecretValueIssue,
  secretValueIssue,
  validateSecretDescription,
} from '@nook/contract';
import { Redacted } from 'effect';

export { IMPORT_KEYS_MAX } from '@nook/contract';
export type ImportRow = {
  id: string;
  line: number;
  name: string;
  description: string;
  included: boolean;
  value: 'present' | SecretValueIssue;
};
export type RowStatus = EnvKeyStatus | 'invalid-description';
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
  return secretValueIssue(Redacted.value(value)) ?? 'present';
}
export function needsFix(status: RowStatus, included: boolean) {
  return (
    status === 'invalid-name' ||
    status === 'invalid-description' ||
    (status === 'duplicate' && included)
  );
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
  const keyStatuses = envKeyStatuses(
    rows.map((row) => ({
      name: row.name,
      value: values.get(row.id) ?? Redacted.make(''),
      counted: row.included,
    })),
    existing,
  );
  const status = new Map<string, RowStatus>(
    rows.map((row, index) => {
      const key = keyStatuses[index];
      const descriptionApplies =
        key === 'ready' || key === 'exists' || key === 'duplicate';
      return [
        row.id,
        descriptionApplies && validateSecretDescription(row.description)
          ? 'invalid-description'
          : key,
      ];
    }),
  );
  const selection: { row: ImportRow; value: Redacted.Redacted<string> }[] = [];
  for (const row of rows) {
    const value = values.get(row.id);
    if (row.included && status.get(row.id) === 'ready' && value)
      selection.push({ row, value });
  }
  const toFix = rows.filter((row) =>
    needsFix(status.get(row.id) as RowStatus, row.included),
  ).length;
  return { status, selection, toFix };
}
