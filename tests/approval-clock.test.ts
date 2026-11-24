import { expect, it } from 'vitest';
import { auditRows } from './support/audit.ts';
import { clockedQuery } from './support/d1-clock.ts';
import {
  approvalClock,
  approvalFixture,
  decide,
  pending,
  requests,
  setMark,
} from './support/owner-approval.ts';

it('a controlled clock sets every time an approval request and its decision store', async () => {
  const requestedAt = Date.parse('2026-11-04T10:42:00.000Z');
  const decidedAt = requestedAt + 5_000;
  const clock = await approvalClock(requestedAt);
  const app = await approvalFixture(undefined, clock);
  try {
    await setMark(app);
    const { id } = await pending(app, app.token);
    expect(await requests(app)).toMatchObject([
      {
        id,
        requested_at: requestedAt,
        expires_at: requestedAt + 600_000,
      },
    ]);
    clock.setTime(decidedAt);
    expect((await decide(app, id, '1h')).status).toBe(200);
    expect(await requests(app)).toMatchObject([
      { id, decided_at: decidedAt, valid_until: decidedAt + 3_600_000 },
    ]);
    expect(
      (await auditRows(app))
        .filter((row) => row.outcome === 'approval_granted')
        .map((row) => row.at),
    ).toEqual([new Date(decidedAt).toISOString()]);
  } finally {
    await app.close();
  }
});

it.each([
  "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')",
  'SELECT "NOW"',
  'SELECT CURRENT_TIMESTAMP',
  'SELECT current_date',
  'SELECT CURRENT_TIME',
  'SELECT unixepoch()',
  'SELECT datetime( )',
  "SELECT datetime('subsec')",
  "SELECT julianday('now')",
  "SELECT strftime('%s')",
  "SELECT UNIXEPOCH('subsec')",
  "SELECT unixepoch( 'subsec' )",
  "SELECT unixepoch(('subsec'))",
  'SELECT strftime("%s")',
  'SELECT datetime("now")',
  'SELECT datetime("subsec")',
  'SELECT datetime(?)',
  "SELECT strftime('%s', ?)",
  "SELECT timediff(at, 'now') FROM t",
  'SELECT datetime(max(a, b)) FROM t',
])('the controlled clock rejects an uncontrolled time read: %s', (query) => {
  expect(() => clockedQuery(query, 0)).toThrow(query);
});

it.each([
  [
    "UPDATE t SET at=strftime('%Y-%m-%dT%H:%M:%fZ', at, '+0.001 seconds'), seen=unixepoch('subsec')*1000 WHERE due>unixepoch('subsec')",
    "UPDATE t SET at=strftime('%Y-%m-%dT%H:%M:%fZ', at, '+0.001 seconds'), seen=(1762252920123/1000.0)*1000 WHERE due>(1762252920123/1000.0)",
  ],
  [
    `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', "updated_at", '+0.001 seconds'), date(a.at) FROM t a`,
    `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', "updated_at", '+0.001 seconds'), date(a.at) FROM t a`,
  ],
  [
    "SELECT strftime('%Y-%m-%dT%H:%M:%fZ',unixepoch('subsec'),'unixepoch')",
    "SELECT strftime('%Y-%m-%dT%H:%M:%fZ',(1762252920123/1000.0),'unixepoch')",
  ],
])(
  'the controlled clock substitutes its time and runs fixed time arithmetic: %s',
  (query, clocked) => {
    expect(clockedQuery(query, 1_762_252_920_123)).toBe(clocked);
  },
);
