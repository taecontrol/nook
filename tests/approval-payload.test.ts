import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { auditRows } from './support/audit.ts';
import {
  approvalFixture,
  ask,
  database,
  pending,
  requests,
  setMark,
  stripe,
} from './support/owner-approval.ts';

it.each([
  {
    initial: { agent: 'codex', session: 's1', thread: 's1' },
    retry: { agent: 'codex', session: 's1' },
  },
  {
    initial: { agent: 'codex', session: 's1', thread: 'invalid thread' },
    retry: { agent: 'codex', session: 's1' },
  },
  { initial: { agent: 'invalid agent', session: 's1' }, retry: undefined },
])(
  'attempt equality uses the normalized claim and distinct unordered paths (%j)',
  async ({ initial, retry }) => {
    const app = await approvalFixture();
    try {
      await setMark(app);
      const id = randomUUID();
      const first = await pending(app, app.token, id, {
        secrets: [stripe, database, stripe],
        agentSession: initial,
      });
      const before = await requests(app);
      const audit = await auditRows(app);
      const response = await ask(app, app.token, id, {
        secrets: [database, stripe],
        agentSession: retry,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toHaveProperty('approval.id', first.id);
      expect(await requests(app)).toEqual(before);
      expect(await auditRows(app)).toEqual(audit);
    } finally {
      await app.close();
    }
  },
);
