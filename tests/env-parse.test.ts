import { parse } from 'dotenv';
import { Redacted } from 'effect';
import { expect, it } from 'vitest';
import { parseEnv } from '../apps/web/src/env-parse.ts';
import { validateSecretName } from '../packages/contract/src/vault.ts';
import { mixedPaste, mixedValues } from './fixtures/vault-import.ts';

it('E1: mixed parses all thirteen keys, their starting lines and only unreadable line 17', () => {
  const parsed = parseEnv(mixedPaste);
  expect(parsed.unreadable).toEqual([17]);
  expect(parsed.entries.map(({ line, name }) => ({ line, name }))).toEqual([
    { line: 2, name: 'NODE_ENV' },
    { line: 3, name: 'PORT' },
    { line: 4, name: 'DATABASE_URL' },
    { line: 5, name: 'REDIS_URL' },
    { line: 6, name: 'STRIPE_SECRET_KEY' },
    { line: 7, name: 'STRIPE_WEBHOOK_SECRET' },
    { line: 8, name: 'SENTRY_DSN' },
    { line: 9, name: 'OPENAI_API_KEY' },
    { line: 10, name: 'next_public_posthog_key' },
    { line: 11, name: 'AWS-REGION' },
    { line: 12, name: 'MAILGUN_API_KEY' },
    { line: 13, name: 'JWT_PRIVATE_KEY' },
    { line: 16, name: 'GITHUB_APP_ID' },
  ]);
  for (const entry of parsed.entries) {
    expect(Redacted.isRedacted(entry.value)).toBe(true);
    expect(Redacted.value(entry.value) === mixedValues[entry.name]).toBe(true);
  }
  expect(JSON.stringify(parsed)).not.toContain(mixedValues.OPENAI_API_KEY);
});

const corpus = [
  {
    syntax: 'comments and blank lines',
    text: '# ignored\n\n  # comment\nKEY=ok\n',
  },
  { syntax: 'export prefix', text: 'export KEY=synthetic-export' },
  { syntax: 'unquoted trim', text: 'KEY=  synthetic-trim  \t' },
  {
    syntax: 'unquoted inline comment',
    text: 'KEY=synthetic-inline   # ignored',
  },
  {
    syntax: 'single quotes keep whitespace',
    text: "KEY='  synthetic single  '",
  },
  {
    syntax: 'double quotes keep whitespace',
    text: 'KEY="  synthetic double  "',
  },
  { syntax: 'backticks keep whitespace', text: 'KEY=`  synthetic backtick  `' },
  { syntax: 'single quoted multiline', text: "KEY='first\nsecond\nthird'" },
  { syntax: 'double quoted multiline', text: 'KEY="first\nsecond\nthird"' },
  { syntax: 'backtick quoted multiline', text: 'KEY=`first\nsecond\nthird`' },
  { syntax: 'double quoted newline escape', text: 'KEY="first\\nsecond"' },
  { syntax: 'single quoted literal escape', text: "KEY='first\\nsecond'" },
  { syntax: 'backtick literal escape', text: 'KEY=`first\\nsecond`' },
  { syntax: 'literal variable reference', text: `BASE=other\nKEY=\${BASE}` },
  {
    syntax: 'CRLF',
    text: '# comment\r\nKEY="first\r\nsecond"\r\nNEXT=last\r\n',
  },
  { syntax: 'UTF-8', text: 'KEY="秘密 🔐 café ñ"' },
  { syntax: '64 KiB value', text: `KEY=${'x'.repeat(64 * 1024)}` },
  { syntax: 'empty value', text: 'KEY=' },
  { syntax: 'spaces around equals', text: 'KEY = value' },
  { syntax: 'quoted hash', text: 'KEY="keep # this" # ignored' },
  {
    syntax: 'Nook accepted names only',
    text: 'bad-key=skip\nlower=skip\n_OK2=keep',
  },
];

it.each(corpus)('E2: dotenv parity for $syntax', ({ text }) => {
  const parsed = parseEnv(text);
  const expected = Object.entries(parse(text)).filter(
    ([name]) => validateSecretName(name) === undefined,
  );
  const accepted = parsed.entries.filter(
    ({ name }) => validateSecretName(name) === undefined,
  );
  expect(accepted.map(({ name }) => name).sort()).toEqual(
    expected.map(([name]) => name).sort(),
  );
  for (const [name, value] of expected) {
    const entry = accepted.find((entry) => entry.name === name);
    if (!entry) throw new Error(`Parsed key ${name} is missing.`);
    expect(Redacted.isRedacted(entry.value)).toBe(true);
    expect(Redacted.value(entry.value) === value).toBe(true);
  }
  expect(parsed.unreadable).toEqual([]);
});

it('E2: unreadable lines report only their original line numbers after multiline values', () => {
  const parsed = parseEnv(
    '# comment\n\nKEY="first\nsecond"\nsynthetic private note\nNEXT=ok\nnot an assignment\n',
  );
  expect(parsed.entries.map(({ line, name }) => ({ line, name }))).toEqual([
    { line: 3, name: 'KEY' },
    { line: 6, name: 'NEXT' },
  ]);
  expect(parsed.unreadable).toEqual([5, 7]);
  expect(JSON.stringify(parsed)).not.toContain('synthetic private note');
  expect(JSON.stringify(parsed)).not.toContain('not an assignment');
});

it('E2: repeated keys preserve both entries and values instead of dotenv last-wins', () => {
  const text = 'DATABASE_URL=synthetic-first\nDATABASE_URL=synthetic-second';
  const parsed = parseEnv(text);
  expect(parsed.entries.map(({ line, name }) => ({ line, name }))).toEqual([
    { line: 1, name: 'DATABASE_URL' },
    { line: 2, name: 'DATABASE_URL' },
  ]);
  expect(parsed.entries.map(({ value }) => Redacted.value(value))).toEqual([
    'synthetic-first',
    'synthetic-second',
  ]);
  expect(parse(text).DATABASE_URL).toBe('synthetic-second');
  expect(parsed.unreadable).toEqual([]);
});
