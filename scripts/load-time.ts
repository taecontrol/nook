import { acmePath, fetchValues } from '../tests/support/audit.ts';
import { createAuthorization } from '../tests/support/authorizations.ts';
import { issueGrant, seedGrantTree } from '../tests/support/grants.ts';
import { manyMemories, seedMemories } from '../tests/support/memory.ts';
import { seedSecrets, vaultRuntime } from '../tests/support/vault.ts';
import { startHostIsolation } from './lib/host-isolation.ts';
import {
  assertLoadTimes,
  formatMeasurements,
  loadTimeBudgets,
  type Measurements,
  measureInitialJs,
} from './lib/load-time.ts';
import { launchTestBrowser } from './lib/test-browser.ts';
import { measureScreen, phonePage } from './load-time-browser.ts';

const isolation = await startHostIsolation();
try {
  const app = await vaultRuntime({ directory: 'dist' });
  const db = await app.mf.getD1Database('DB');
  await seedGrantTree(app);
  await seedSecrets(app);
  await seedMemories(app, manyMemories);
  const { token } = await issueGrant(app);
  const used = await fetchValues(app, token, { secrets: [acmePath] });
  if (used.status !== 200)
    throw new Error('The Audit timing fixture requires a genuine use.');
  await used.body?.cancel();
  const pending = await createAuthorization(app);
  await db
    .prepare(
      'INSERT INTO machine_tokens(token_hash, machine_name, grant_json, created_at, id) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(
      'synthetic-load-time-hash',
      'load-time-machine',
      '"all"',
      Date.now(),
      'synthetic-load-time-id',
    )
    .run();
  const { browser, close: closeBrowser } = await launchTestBrowser();
  try {
    const measured: Measurements = {
      home: [],
      buckets: [],
      navigation: [],
      authorize: [],
      machines: [],
      machinesNavigation: [],
      approvalNavigation: [],
      vault: [],
      vaultNavigation: [],
      audit: [],
      auditNavigation: [],
      memory: [],
      memoryNavigation: [],
      gzipBytes: (await measureInitialJs('dist/assets')).gzipBytes,
    };
    for (const kind of [
      'home',
      'buckets',
      'authorize',
      'navigation',
      'machines',
      'machinesNavigation',
      'approvalNavigation',
      'vault',
      'vaultNavigation',
      'audit',
      'auditNavigation',
      'memory',
      'memoryNavigation',
    ] as const) {
      for (let run = 0; run < loadTimeBudgets.runs; run++) {
        const { context, page } = await phonePage(browser, kind);
        try {
          measured[kind].push(
            await measureScreen(page, app.origin, pending.userCode, kind),
          );
        } finally {
          await context.close();
        }
      }
    }
    console.log(formatMeasurements(measured));
    assertLoadTimes(measured);
  } finally {
    await closeBrowser();
    await app.close();
  }
} finally {
  await isolation.close();
}
