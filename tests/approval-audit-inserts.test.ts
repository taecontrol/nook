import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { auditRows, fetchValues } from './support/audit.ts';
import {
  approvalFixture,
  ask,
  database,
  decide,
  pending,
  setMark,
  stripe,
  withdraw,
} from './support/owner-approval.ts';

it('every approval audit insert keeps independent v4 IDs and the exact path bucket', async () => {
  const app = await approvalFixture();
  try {
    await setMark(app);
    const secrets = [stripe, database];
    expect((await fetchValues(app, app.token, { secrets })).status).toBe(503);
    const attempt = randomUUID();
    const granted = await pending(app, app.token, attempt, { secrets });
    expect((await decide(app, granted.id)).status).toBe(200);
    expect((await ask(app, app.token, attempt, { secrets })).status).toBe(200);
    const denied = await pending(app, app.token, undefined, { secrets });
    expect((await decide(app, denied.id, 'deny')).status).toBe(200);
    const cancelled = await pending(app, app.token, undefined, { secrets });
    expect((await withdraw(app, app.token, cancelled.id)).status).toBe(204);
    const rows = await auditRows(app);
    expect(rows).toHaveLength(16);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    for (const row of rows) {
      expect(row.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(row.bucket).toBe(
        row.path === stripe ? 'work/acme' : 'work/acme/prod',
      );
    }
    expect(rows.map((row) => row.outcome)).toEqual(
      expect.arrayContaining([
        'approval_refused',
        'approval_requested',
        'approval_granted',
        'delivered',
        'approval_denied',
        'approval_withdrawn',
      ]),
    );
  } finally {
    await app.close();
  }
});
