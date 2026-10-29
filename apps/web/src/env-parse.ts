import type { Redacted } from 'effect';

export type EnvEntry = {
  line: number;
  name: string;
  value: Redacted.Redacted<string>;
};
export type ParsedEnv = {
  entries: readonly EnvEntry[];
  unreadable: readonly number[];
};

export function parseEnv(_text: string): ParsedEnv {
  throw new Error('not implemented');
}
