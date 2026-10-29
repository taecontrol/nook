import type { Redacted } from 'effect';
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
  _parsed: ParsedEnv,
): { rows: ImportRow[] } | { tooMany: number } {
  throw new Error('not implemented');
}

export function review(
  _rows: readonly ImportRow[],
  _values: ReadonlyMap<string, Redacted.Redacted<string>>,
  _existing: ReadonlySet<string>,
): {
  status: ReadonlyMap<string, RowStatus>;
  selection: ImportSelection;
  toFix: number;
} {
  throw new Error('not implemented');
}
