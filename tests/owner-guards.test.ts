import { expect, it } from 'vitest';
import { jsonRequest } from './support/authorizations.ts';
import { vaultCheckpoints } from './support/vault-checkpoints.ts';

it('whole-installation owner guards return the same Forbidden body before D1', async () => {
  const labels: string[] = [];
  const app = await vaultCheckpoints(
    async (label) => {
      labels.push(label);
      return true;
    },
    ['me'],
  );
  try {
    for (const [path, method, payload] of [
      ['/api/ask-first', 'GET'],
      ['/api/ask-first/bucket/work', 'PUT'],
      ['/api/ask-first/bucket/work', 'DELETE'],
      ['/api/approvals', 'GET'],
      ['/api/approvals/missing', 'GET'],
      ['/api/approvals/missing/approve', 'POST', { remember: 'once' }],
      ['/api/approvals/missing/deny', 'POST'],
      ['/api/machines', 'GET'],
      ['/api/machines/missing', 'DELETE'],
      ['/api/machines/missing/grant', 'PUT', { grant: 'all', previous: 'all' }],
      ['/api/audit', 'GET'],
      ['/api/secrets', 'GET'],
    ] as const) {
      labels.length = 0;
      const response = await jsonRequest(app, path, payload, {}, method);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ _tag: 'Forbidden' });
      expect(labels).toEqual([]);
    }
  } finally {
    await app.close();
  }
});
