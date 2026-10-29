import { Redacted } from 'effect';
import { expect, it } from 'vitest';
import { type EnvEntry, parseEnv } from '../apps/web/src/env-parse.ts';
import {
  IMPORT_KEYS_MAX,
  type ImportRow,
  review,
  rowsFrom,
} from '../apps/web/src/vault-import-model.ts';
import {
  validateSecretDescription,
  validateSecretName,
} from '../packages/contract/src/vault.ts';
import {
  existingNames,
  mixedPaste,
  readyNames,
} from './fixtures/vault-import.ts';

function entries(pairs: readonly (readonly [string, string])[]): EnvEntry[] {
  return pairs.map(([name, value], index) => ({
    line: index + 1,
    name,
    value: Redacted.make(value),
  }));
}
function model(parsed: readonly EnvEntry[]) {
  const result = rowsFrom({ entries: parsed, unreadable: [] });
  if ('tooMany' in result) throw new Error('Expected review rows.');
  const values = new Map(
    result.rows.map((row, index) => [row.id, parsed[index].value]),
  );
  return { rows: result.rows, values };
}
function statuses(
  rows: readonly ImportRow[],
  result: ReturnType<typeof review>,
) {
  return rows.map((row) => [row.name, result.status.get(row.id)]);
}
const selectedNames = (result: ReturnType<typeof review>) =>
  result.selection.map(({ row }) => row.name);

it('E1: mixed review has exactly eight Ready, two existing, two invalid and one empty row', () => {
  const parsed = parseEnv(mixedPaste);
  const { rows, values } = model(parsed.entries);
  const result = review(rows, values, new Set(existingNames));
  expect(statuses(rows, result)).toEqual([
    ['NODE_ENV', 'ready'],
    ['PORT', 'ready'],
    ['DATABASE_URL', 'ready'],
    ['REDIS_URL', 'ready'],
    ['STRIPE_SECRET_KEY', 'exists'],
    ['STRIPE_WEBHOOK_SECRET', 'ready'],
    ['SENTRY_DSN', 'exists'],
    ['OPENAI_API_KEY', 'ready'],
    ['next_public_posthog_key', 'invalid-name'],
    ['AWS-REGION', 'invalid-name'],
    ['MAILGUN_API_KEY', 'empty'],
    ['JWT_PRIVATE_KEY', 'ready'],
    ['GITHUB_APP_ID', 'ready'],
  ]);
  expect(selectedNames(result)).toEqual(readyNames);
  expect(result.toFix).toBe(2);
  expect(parsed.unreadable).toEqual([17]);
});

it('E3: every duplicate is blocked and unchecking one makes the other Ready', () => {
  const { rows, values } = model(
    entries([
      ['DATABASE_URL', 'synthetic-first'],
      ['DATABASE_URL', 'synthetic-second'],
    ]),
  );
  const duplicate = review(rows, values, new Set());
  expect(statuses(rows, duplicate)).toEqual([
    ['DATABASE_URL', 'duplicate'],
    ['DATABASE_URL', 'duplicate'],
  ]);
  expect(duplicate.selection).toEqual([]);
  expect(duplicate.toFix).toBe(2);
  const unchecked = rows.map((row, index) => ({
    ...row,
    included: index === 0,
  }));
  const result = review(unchecked, values, new Set());
  expect(result.status.get(rows[0].id)).toBe('ready');
  expect(
    result.selection.map(({ row, value }) => [row.id, Redacted.value(value)]),
  ).toEqual([[rows[0].id, 'synthetic-first']]);
  expect(result.toFix).toBe(0);
});

it('E3: renaming one duplicate makes both distinct names Ready', () => {
  const { rows, values } = model(
    entries([
      ['DATABASE_URL', 'first'],
      ['DATABASE_URL', 'second'],
    ]),
  );
  rows[1].name = 'OTHER_DATABASE_URL';
  const result = review(rows, values, new Set());
  expect(statuses(rows, result)).toEqual([
    ['DATABASE_URL', 'ready'],
    ['OTHER_DATABASE_URL', 'ready'],
  ]);
  expect(selectedNames(result)).toEqual(['DATABASE_URL', 'OTHER_DATABASE_URL']);
  expect(result.toFix).toBe(0);
});

it('E4: editing a name recomputes Ready, Already exists and both Duplicate statuses', () => {
  const { rows, values } = model(
    entries([
      ['next_public_posthog_key', 'synthetic-posthog'],
      ['OTHER_KEY', 'synthetic-other'],
    ]),
  );
  const existing = new Set(['SENTRY_DSN']);
  expect(review(rows, values, existing).status.get(rows[0].id)).toBe(
    'invalid-name',
  );
  rows[0].name = 'NEXT_PUBLIC_POSTHOG_KEY';
  expect(review(rows, values, existing).status.get(rows[0].id)).toBe('ready');
  rows[0].name = 'SENTRY_DSN';
  expect(review(rows, values, existing).status.get(rows[0].id)).toBe('exists');
  rows[0].name = 'OTHER_KEY';
  expect(statuses(rows, review(rows, values, existing))).toEqual([
    ['OTHER_KEY', 'duplicate'],
    ['OTHER_KEY', 'duplicate'],
  ]);
});

it.each([
  '',
  'lowercase',
  'AWS-REGION',
  '1TOKEN',
  'A'.repeat(65),
  'A'.repeat(64),
  '_OK2',
])('E4: review uses validateSecretName for %j', (name) => {
  const { rows, values } = model(entries([[name, 'synthetic-name-rule']]));
  const result = review(rows, values, new Set());
  const valid = validateSecretName(name) === undefined;
  expect(result.status.get(rows[0].id)).toBe(valid ? 'ready' : 'invalid-name');
  expect(result.selection).toHaveLength(valid ? 1 : 0);
});

it('E5: the 64 KiB UTF-8 boundary and empty values determine eligibility without retaining values in rows', () => {
  const exact = '🔐'.repeat(16 * 1024);
  const { rows, values } = model(
    entries([
      ['EXACT', exact],
      ['OVER', `${exact}x`],
      ['EMPTY', ''],
    ]),
  );
  expect(rows.map(({ value }) => value)).toEqual([
    'present',
    'too-long',
    'empty',
  ]);
  expect(rows.every((row) => row.description === '' && row.included)).toBe(
    true,
  );
  const result = review(rows, values, new Set());
  expect(statuses(rows, result)).toEqual([
    ['EXACT', 'ready'],
    ['OVER', 'too-long'],
    ['EMPTY', 'empty'],
  ]);
  expect(selectedNames(result)).toEqual(['EXACT']);
  expect(JSON.stringify(rows)).not.toContain('🔐');
});

it.each([
  {
    issue: '201 Unicode characters',
    description: '😀'.repeat(201),
    message: 'A description can have at most 200 characters.',
  },
  {
    issue: 'multiple lines',
    description: 'first\nsecond',
    message: 'Use one line for the description.',
  },
])(
  'E5: a description with $issue is blocked with the contract message',
  ({ description, message }) => {
    const { rows, values } = model(entries([['KEY', 'synthetic-description']]));
    rows[0].description = description;
    const result = review(rows, values, new Set());
    expect(result.status.get(rows[0].id)).toBe('invalid-description');
    expect(result.selection).toEqual([]);
    expect(result.toFix).toBe(1);
    expect(validateSecretDescription(rows[0].description)).toBe(message);
    rows[0].description = '😀'.repeat(200);
    expect(review(rows, values, new Set()).status.get(rows[0].id)).toBe(
      'ready',
    );
  },
);

it('E6: switching from work/acme/api to me recomputes existing names and selects nine', () => {
  const { rows, values } = model(parseEnv(mixedPaste).entries);
  expect(selectedNames(review(rows, values, new Set(existingNames)))).toEqual(
    readyNames,
  );
  const result = review(rows, values, new Set(['OPENAI_API_KEY']));
  expect(statuses(rows, result)).toContainEqual(['OPENAI_API_KEY', 'exists']);
  expect(statuses(rows, result)).toContainEqual(['STRIPE_SECRET_KEY', 'ready']);
  expect(statuses(rows, result)).toContainEqual(['SENTRY_DSN', 'ready']);
  expect(selectedNames(result).sort()).toEqual(
    [
      ...readyNames.filter((name) => name !== 'OPENAI_API_KEY'),
      ...existingNames,
    ].sort(),
  );
  expect(result.selection).toHaveLength(9);
});

it('E7: 101 parsed keys cannot become review rows; exactly 100 can', () => {
  expect(IMPORT_KEYS_MAX).toBe(100);
  const parsed = entries(
    Array.from(
      { length: 101 },
      (_, index) => [`KEY_${index}`, 'synthetic-limit'] as const,
    ),
  );
  expect(rowsFrom({ entries: parsed, unreadable: [] })).toEqual({
    tooMany: 101,
  });
  const accepted = rowsFrom({ entries: parsed.slice(0, 100), unreadable: [] });
  expect(accepted).toHaveProperty('rows');
  if ('tooMany' in accepted)
    throw new Error('Exactly 100 keys must reach review.');
  expect(accepted.rows).toHaveLength(100);
});

it('E8: selection counts only checked Ready rows and is empty when all are unchecked', () => {
  const { rows, values } = model(
    entries([
      ['READY', 'synthetic-ready'],
      ['UNCHECKED', 'synthetic-unchecked'],
      ['EXISTING', 'synthetic-existing'],
      ['invalid', 'synthetic-invalid'],
      ['EMPTY', ''],
    ]),
  );
  rows[1].included = false;
  const existing = new Set(['EXISTING']);
  expect(selectedNames(review(rows, values, existing))).toEqual(['READY']);
  const unchecked = rows.map((row) => ({ ...row, included: false }));
  expect(review(unchecked, values, existing).selection).toEqual([]);
});
