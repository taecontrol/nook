import type { WholeInstallationGrant } from '@nook/contract';
import type { Effect } from 'effect';
import { expect, expectTypeOf, it } from 'vitest';
import type { ownerApprovals } from '../apps/worker/src/approvals.ts';
import type { askFirstStore } from '../apps/worker/src/ask-first.ts';
import type { auditStore } from '../apps/worker/src/audit.ts';
import type { machineOperations } from '../apps/worker/src/machines.ts';
import {
  matches,
  ownerRoutes,
  type Route,
  wholeInstallationRoutes,
} from '../apps/worker/src/routes.ts';
import type { ownerVault } from '../apps/worker/src/vault.ts';
import { jsonRequest } from './support/authorizations.ts';
import { vaultCheckpoints } from './support/vault-checkpoints.ts';

const routeKey = ({ method, path }: Route) => `${method} ${path}`;

// Every Api endpoint that does not require the whole-installation grant must
// appear here (either bucket-scoped or session identity). Adding an unguarded
// endpoint to Api fails this classification until it is either guarded with
// RequireWholeInstallation or explicitly listed here with bucket-grant tests.
const scopedOrSessionRoutes = [
  'DELETE /api/memories/:id',
  'GET /api/memories/:id/versions',
  'GET /api/memories/search',
  'GET /api/memories/counts',
  'GET /api/memories',
  'GET /api/memories/:id',
  'GET /api/memories/:id/files/:name',
  'GET /api/whoami',
  'GET /api/buckets',
  'POST /api/buckets',
  'DELETE /api/buckets/:path',
  'POST /api/secrets/:path/reveal',
  'POST /api/secrets',
  'PUT /api/secrets/:path',
  'DELETE /api/secrets/:path',
];

const requestsByRoute: Record<
  string,
  readonly (readonly [path: string, payload?: unknown])[]
> = {
  'GET /api/ask-first': [['/api/ask-first']],
  'PUT /api/ask-first/:kind/:path': [
    ['/api/ask-first/bucket/work'],
    // Middleware refuses before schema decoding, so invalid params still answer 403.
    ['/api/ask-first/bogus/work'],
  ],
  'DELETE /api/ask-first/:kind/:path': [['/api/ask-first/bucket/work']],
  'GET /api/approvals': [['/api/approvals']],
  'GET /api/approvals/:id': [['/api/approvals/missing']],
  'POST /api/approvals/:id/approve': [
    ['/api/approvals/missing/approve', { remember: 'once' }],
    ['/api/approvals/missing/approve', {}],
  ],
  'POST /api/approvals/:id/deny': [['/api/approvals/missing/deny']],
  'GET /api/machines': [['/api/machines']],
  'DELETE /api/machines/:id': [['/api/machines/missing']],
  'PUT /api/machines/:id/grant': [
    ['/api/machines/missing/grant', { grant: 'all', previous: 'all' }],
    // A caller whose grant covers the previous grant still cannot widen it.
    ['/api/machines/missing/grant', { grant: 'all', previous: ['me'] }],
  ],
  'GET /api/audit': [['/api/audit']],
  'GET /api/secrets': [['/api/secrets']],
};

it('classifies every Api endpoint as either RequireWholeInstallation or scoped/session', () => {
  const guarded = wholeInstallationRoutes.map(routeKey);
  expect(guarded.filter((key) => scopedOrSessionRoutes.includes(key))).toEqual(
    [],
  );
  expect([...guarded, ...scopedOrSessionRoutes].sort()).toEqual(
    ownerRoutes.map(routeKey).sort(),
  );
  expect(Object.keys(requestsByRoute).sort()).toEqual([...guarded].sort());
});

it('requires WholeInstallationGrant in the Effect context of every whole-installation store operation', () => {
  type AskFirst = Effect.Success<typeof askFirstStore>;
  type Approvals = Effect.Success<typeof ownerApprovals>;
  type Machines = Effect.Success<typeof machineOperations>;
  type Audit = Effect.Success<typeof auditStore>;
  type Vault = Effect.Success<ReturnType<typeof ownerVault>>;

  expectTypeOf<
    Effect.Services<ReturnType<AskFirst['list']>>
  >().toEqualTypeOf<WholeInstallationGrant>();
  expectTypeOf<
    Effect.Services<ReturnType<AskFirst['put']>>
  >().toEqualTypeOf<WholeInstallationGrant>();
  expectTypeOf<
    Effect.Services<ReturnType<AskFirst['remove']>>
  >().toEqualTypeOf<WholeInstallationGrant>();
  expectTypeOf<
    Effect.Services<ReturnType<Approvals['list']>>
  >().toEqualTypeOf<WholeInstallationGrant>();
  expectTypeOf<
    Effect.Services<ReturnType<Approvals['get']>>
  >().toEqualTypeOf<WholeInstallationGrant>();
  expectTypeOf<
    Effect.Services<ReturnType<Approvals['decide']>>
  >().toEqualTypeOf<WholeInstallationGrant>();
  expectTypeOf<
    Effect.Services<ReturnType<Machines['list']>>
  >().toEqualTypeOf<WholeInstallationGrant>();
  expectTypeOf<
    Effect.Services<ReturnType<Machines['saveGrant']>>
  >().toEqualTypeOf<WholeInstallationGrant>();
  expectTypeOf<
    Effect.Services<ReturnType<Machines['revoke']>>
  >().toEqualTypeOf<WholeInstallationGrant>();
  expectTypeOf<
    Effect.Services<ReturnType<Audit['list']>>
  >().toEqualTypeOf<WholeInstallationGrant>();
  expectTypeOf<
    Effect.Services<ReturnType<Vault['listAll']>>
  >().toEqualTypeOf<WholeInstallationGrant>();
});

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
    for (const route of wholeInstallationRoutes) {
      const key = routeKey(route);
      for (const [path, payload] of requestsByRoute[key]) {
        expect(matches([route], route.method, path), key).toBe(true);
        labels.length = 0;
        const response = await jsonRequest(
          app,
          path,
          payload,
          {},
          route.method,
        );
        expect(response.status, key).toBe(403);
        expect(await response.json(), key).toEqual({ _tag: 'Forbidden' });
        expect(labels, key).toEqual([]);
      }
    }
  } finally {
    await app.close();
  }
});
