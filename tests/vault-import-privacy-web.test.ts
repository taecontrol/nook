import { expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { privateClientState } from './support/vault-browser.ts';
import { vaultCache } from './support/vault-cache.ts';
import {
  createImport,
  holdImportCreates,
  importPage,
  importSettled,
  reviewPaste,
} from './support/vault-import-browser.ts';

it('E17: the privacy probe detects private text and exact private UUIDs while allowing unrelated metadata UUIDs', async () => {
  const launched = await launchTestBrowser();
  const visit = await importPage(launched.browser);
  const id = '11111111-1111-4000-8111-111111111111';
  try {
    const cache = await vaultCache(visit.page);
    await cache.evaluate(
      (client, id) => client.setQueryData(['privacy-probe'], { version: id }),
      id,
    );
    expect(await privateClientState(visit.page, ['4000'])).toEqual({
      found: true,
      absentFromCache: true,
      absentFromDom: true,
    });
    expect(await privateClientState(visit.page, [id])).toEqual({
      found: true,
      absentFromCache: false,
      absentFromDom: true,
    });
    await cache.evaluate((client) =>
      client.setQueryData(['privacy-probe'], { value: '4000' }),
    );
    expect(await privateClientState(visit.page, ['4000'])).toEqual({
      found: true,
      absentFromCache: false,
      absentFromDom: true,
    });
    await cache.evaluate((client) =>
      client.removeQueries({ queryKey: ['privacy-probe'] }),
    );
    await cache.dispose();
  } finally {
    await visit.close();
    await launched.close();
  }
});

it('E15: the write gate stays held at every mutation transition until every queued key settles', async () => {
  const launched = await launchTestBrowser();
  const visit = await importPage(launched.browser);
  const pool = await holdImportCreates(visit.page);
  try {
    const cache = await vaultCache(visit.page);
    const probe = await cache.evaluateHandle((client) => {
      const gaps: number[] = [];
      const stop = client.getMutationCache().subscribe((event) => {
        if (event.type !== 'updated') return;
        const writes = client
          .getMutationCache()
          .getAll()
          .filter(
            (write) =>
              (write.state.variables as { batch?: string } | undefined)?.batch,
          );
        if (!writes.length) return;
        const pending = client.isMutating({ mutationKey: ['vault', 'write'] });
        const settled = writes.filter(
          (write) =>
            write.state.status === 'success' || write.state.status === 'error',
        ).length;
        if (pending === 0 && settled < 4) gaps.push(settled);
      });
      return { gaps, stop };
    });
    await reviewPaste(
      visit.page,
      'FIRST=synthetic-first\nSECOND=synthetic-second\nTHIRD=synthetic-third\nFOURTH=synthetic-fourth',
    );
    await createImport(visit.page, 4);
    await expect.poll(() => pool.held.length).toBe(3);
    pool.held[0].gate.resolve();
    await expect.poll(() => pool.held.length).toBe(4);
    pool.releaseAll();
    await importSettled(visit.page);
    expect(await probe.evaluate((probe) => probe.gaps)).toEqual([]);
    await probe.evaluate((probe) => probe.stop());
    await probe.dispose();
    await cache.dispose();
  } finally {
    pool.releaseAll();
    await visit.close();
    await launched.close();
  }
});
