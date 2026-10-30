import type { Page } from 'playwright';
import { expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { privateClientState } from './support/vault-browser.ts';
import { vaultCache } from './support/vault-cache.ts';
import {
  createImport,
  holdImportCreates,
  importPage,
  importSettled,
  openImport,
  pasteField,
  reviewPaste,
} from './support/vault-import-browser.ts';

function privacyProbeRef(page: Page) {
  return pasteField(page).evaluateHandle((element) => {
    type Fiber = {
      return?: Fiber;
      child?: Fiber;
      sibling?: Fiber;
      stateNode?: { current?: Fiber };
      memoizedProps?: {
        textRef?: { current: unknown };
        parsed?: { entries: { value: unknown }[] };
      };
    };
    const key = Object.keys(element).find((key) =>
      key.startsWith('__reactFiber$'),
    );
    let root = key
      ? (element as unknown as Record<string, Fiber>)[key]
      : undefined;
    while (root?.return) root = root.return;
    const seen = new WeakSet<object>();
    const find = (
      fiber: Fiber | undefined,
    ):
      | {
          ref: { current: unknown };
          original: unknown;
          redacted: unknown;
        }
      | undefined => {
      if (!fiber || seen.has(fiber)) return;
      seen.add(fiber);
      const props = fiber.memoizedProps;
      if (props?.textRef && props.parsed?.entries[0])
        return {
          ref: props.textRef,
          original: props.textRef.current,
          redacted: props.parsed.entries[0].value,
        };
      return find(fiber.child) ?? find(fiber.sibling);
    };
    const probe = find(root?.stateNode?.current ?? root);
    if (!probe)
      throw new Error('Import textarea ref and redacted value missing.');
    return probe;
  });
}

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
    await openImport(visit.page);
    const value = 'synthetic-nested-private-value';
    await pasteField(visit.page).fill(`PRIVACY_PROBE=${value}`);
    const probe = await privacyProbeRef(visit.page);
    await pasteField(visit.page).fill('');
    try {
      for (const source of ['ref', 'cache'])
        for (const kind of ['text', 'Redacted'])
          for (const key of [
            'child',
            'alternate',
            'return',
            'sibling',
            'stateNode',
          ]) {
            await probe.evaluate(
              (probe, { client, source, kind, key, value }) => {
                const nested = {
                  tag: 0,
                  [key]: kind === 'Redacted' ? probe.redacted : value,
                };
                if (source === 'ref') probe.ref.current = nested;
                else client.setQueryData(['privacy-probe'], nested);
              },
              { client: cache, source, kind, key, value },
            );
            for (const inspectReact of [false, true])
              expect
                .soft(
                  await privateClientState(visit.page, [value], {
                    inspectReact,
                  }),
                  `${source}.${key}: ${kind}, inspectReact=${inspectReact}`,
                )
                .toEqual({
                  found: true,
                  absentFromCache: false,
                  absentFromDom: true,
                });
            if (kind === 'Redacted')
              expect(
                await privateClientState(visit.page, [value], {
                  allowRedacted: true,
                  inspectReact: true,
                }),
              ).toEqual({
                found: true,
                absentFromCache: true,
                absentFromDom: true,
              });
            await probe.evaluate((probe) => {
              probe.ref.current = probe.original;
            });
            await cache.evaluate((client) =>
              client.removeQueries({ queryKey: ['privacy-probe'] }),
            );
          }
    } finally {
      await probe.evaluate((probe) => {
        probe.ref.current = probe.original;
      });
      await probe.dispose();
    }
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
