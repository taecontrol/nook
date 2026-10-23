import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { deferred } from './support/machines.ts';
import {
  memoryClient,
  memoryFixture,
  memoryId,
  seedMemories,
} from './support/memory.ts';
import { fileBucket, fileMemory, pdfName } from './support/memory-files.ts';
import {
  filesControl,
  filesPage,
  filesSheet,
  openFiles,
  waitFileRows,
} from './support/memory-files-browser.ts';
import {
  confirmForget,
  memoryQueries,
  openForget,
} from './support/memory-forget.ts';

let browser: Browser;
let closeBrowser: (() => Promise<void>) | undefined;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(() => closeBrowser?.());

it('keeps an in-flight download and its peer lock when Files is dismissed and reopened', async () => {
  const gate = deferred();
  const arrived = deferred();
  let downloads = 0;
  const visit = await filesPage(browser, {
    configure: async (page) => {
      await page.route('**/api/memories/*/files/*', async (route) => {
        downloads += 1;
        arrived.resolve();
        await gate.promise;
        await route.continue().catch(() => {});
      });
    },
  });
  try {
    const { page, files } = visit;
    await openFiles(page);
    const button = filesSheet(page).getByRole('button', {
      name: `Download ${files[0].name}`,
      exact: true,
    });
    await button.click();
    await arrived.promise;
    await page.keyboard.press('Escape');
    await expect.poll(() => filesSheet(page).count()).toBe(0);
    await openFiles(page);
    expect(await button.getAttribute('aria-busy')).toBe('true');
    for (const peer of await filesSheet(page)
      .getByRole('button', { name: /^Download / })
      .all())
      expect(await peer.isDisabled()).toBe(true);
    expect(downloads).toBe(1);
    const saved = page.waitForEvent('download');
    gate.resolve();
    expect((await saved).suggestedFilename()).toBe(files[0].name);
    await expect.poll(() => button.isEnabled()).toBe(true);
  } finally {
    gate.resolve();
    await visit.close();
  }
});

it('retains the missing-file warning when refresh fails, retries, and returns focus to History after the last file disappears', async () => {
  let unavailable = false;
  const visit = await filesPage(browser, {
    names: [pdfName],
    configure: async (page) => {
      await page.route(`**/api/memories/${fileMemory}`, (route) =>
        unavailable
          ? route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: '{"_tag":"ServiceUnavailable"}',
            })
          : route.continue(),
      );
    },
  });
  try {
    const { page, app, files } = visit;
    await openFiles(page);
    expect(
      (
        await memoryClient(app, '2026-07-28').call('detach', {
          id: fileMemory,
          name: pdfName,
          sha256: files[0].sha256,
        })
      ).isError,
    ).not.toBe(true);
    unavailable = true;
    await filesSheet(page)
      .getByRole('button', { name: `Download ${pdfName}`, exact: true })
      .click();
    const alert = filesSheet(page).getByRole('alert');
    await alert.getByText(/Could not refresh the list/).waitFor();
    expect(await alert.innerText()).toContain('File not found.');
    expect(await alert.innerText()).not.toContain('The list is up to date.');
    await waitFileRows(page, 1);
    unavailable = false;
    await alert.getByRole('button', { name: 'Try again', exact: true }).click();
    await waitFileRows(page, 0);
    await page.keyboard.press('Escape');
    await expect
      .poll(() =>
        page
          .locator('[data-memory-history]')
          .evaluate((el) => document.activeElement === el),
      )
      .toBe(true);
    expect(await filesControl(page).count()).toBe(0);
    expect(new URL(page.url()).searchParams.has('files')).toBe(false);
  } finally {
    await visit.close();
  }
});

it('reuses cached detail on intent/open and restores a reloadable Files location with keyboard focus', async () => {
  const reads: string[] = [];
  const visit = await filesPage(browser, {
    configure: async (page) => {
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === `/api/memories/${fileMemory}`)
          reads.push(request.url());
      });
    },
  });
  try {
    const { page } = visit;
    await page.waitForLoadState('networkidle');
    expect(reads).toHaveLength(1);
    await filesControl(page).focus();
    await page.waitForLoadState('networkidle');
    await page.keyboard.press('Enter');
    await waitFileRows(page, 3);
    expect(reads).toHaveLength(1);
    expect(new URL(page.url()).searchParams.get('files')).toBe('1');
    await page.keyboard.press('Escape');
    await expect
      .poll(() =>
        filesControl(page).evaluate((el) => document.activeElement === el),
      )
      .toBe(true);
    await page.goBack();
    await waitFileRows(page, 3);
    await page.reload();
    await waitFileRows(page, 3);
    await filesSheet(page)
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await expect
      .poll(() =>
        filesControl(page).evaluate((el) => document.activeElement === el),
      )
      .toBe(true);
  } finally {
    await visit.close();
  }
});

it('a late missing-file response refreshes its original memory after navigating to another memory', async () => {
  const gate = deferred();
  const arrived = deferred();
  const reads: string[] = [];
  const otherId = memoryId(602);
  const visit = await filesPage(browser, {
    names: [pdfName],
    configure: async (page, app) => {
      await seedMemories(app, [
        memoryFixture(602, { bucket: fileBucket, content: '# Another memory' }),
      ]);
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (
          path === `/api/memories/${fileMemory}` ||
          path === `/api/memories/${otherId}`
        )
          reads.push(path);
      });
      await page.route('**/api/memories/*/files/*', async (route) => {
        arrived.resolve();
        await gate.promise;
        await route.continue().catch(() => {});
      });
    },
  });
  try {
    const { page, app, files } = visit;
    await openFiles(page);
    await filesSheet(page)
      .getByRole('button', { name: `Download ${pdfName}`, exact: true })
      .click();
    await arrived.promise;
    await page.keyboard.press('Escape');
    await page.locator(`[data-memory-row="${otherId}"]`).click();
    await page
      .getByRole('heading', { name: 'Another memory', exact: true })
      .waitFor();
    expect(
      (
        await memoryClient(app, '2026-07-28').call('detach', {
          id: fileMemory,
          name: pdfName,
          sha256: files[0].sha256,
        })
      ).isError,
    ).not.toBe(true);
    const before = reads.length;
    gate.resolve();
    await expect
      .poll(() => reads.slice(before))
      .toEqual([`/api/memories/${fileMemory}`]);
    await page.waitForLoadState('networkidle');
    expect(reads.slice(before)).toEqual([`/api/memories/${fileMemory}`]);
    expect(new URL(page.url()).searchParams.get('memory')).toBe(otherId);
    await page.locator(`[data-memory-row="${fileMemory}"]`).click();
    await page
      .getByRole('heading', { name: 'File guide', exact: true })
      .waitFor();
    expect(await filesControl(page).count()).toBe(0);
  } finally {
    gate.resolve();
    await visit.close();
  }
});

it('keeps a pending download and all peer locks across A to B to A navigation', async () => {
  const gate = deferred();
  const arrived = deferred();
  const otherId = memoryId(602);
  let downloads = 0;
  const visit = await filesPage(browser, {
    configure: async (page, app) => {
      await seedMemories(app, [
        memoryFixture(602, { bucket: fileBucket, content: '# Another memory' }),
      ]);
      await page.route('**/api/memories/*/files/*', async (route) => {
        downloads += 1;
        arrived.resolve();
        await gate.promise;
        await route.continue().catch(() => {});
      });
    },
  });
  try {
    const { page, files } = visit;
    await openFiles(page);
    const button = filesSheet(page).getByRole('button', {
      name: `Download ${files[0].name}`,
      exact: true,
    });
    await button.click();
    await arrived.promise;
    await page.keyboard.press('Escape');
    await page.locator(`[data-memory-row="${otherId}"]`).click();
    await page
      .getByRole('heading', { name: 'Another memory', exact: true })
      .waitFor();
    await page.locator(`[data-memory-row="${fileMemory}"]`).click();
    await page
      .getByRole('heading', { name: 'File guide', exact: true })
      .waitFor();
    await openFiles(page);
    expect(await button.getAttribute('aria-busy')).toBe('true');
    for (const peer of await filesSheet(page)
      .getByRole('button', { name: /^Download / })
      .all())
      expect(await peer.isDisabled()).toBe(true);
    expect(downloads).toBe(1);
    const saved = page.waitForEvent('download');
    gate.resolve();
    expect((await saved).suggestedFilename()).toBe(files[0].name);
    await expect.poll(() => button.isEnabled()).toBe(true);
  } finally {
    gate.resolve();
    await visit.close();
  }
});

it('a late missing-file response does not read or repopulate a memory while forget is pending', async () => {
  const downloadGate = deferred();
  const downloadArrived = deferred();
  const forgetGate = deferred();
  const forgetArrived = deferred();
  const reads: string[] = [];
  const visit = await filesPage(browser, {
    names: [pdfName],
    configure: async (page, app) => {
      await seedMemories(app, [
        memoryFixture(602, { bucket: fileBucket, content: '# Another memory' }),
      ]);
      page.on('request', (request) => {
        if (
          request.method() === 'GET' &&
          /^\/api\/memories\/[^/]+$/.test(new URL(request.url()).pathname)
        )
          reads.push(request.url());
      });
      await page.route('**/api/memories/*/files/*', async (route) => {
        downloadArrived.resolve();
        await downloadGate.promise;
        await route.continue().catch(() => {});
      });
      await page.route('**/api/memories/*?expectedVersion=*', async (route) => {
        forgetArrived.resolve();
        await forgetGate.promise;
        await route.continue().catch(() => {});
      });
    },
  });
  try {
    const { page, app, files } = visit;
    await openFiles(page);
    await filesSheet(page)
      .getByRole('button', { name: `Download ${pdfName}`, exact: true })
      .click();
    await downloadArrived.promise;
    expect(
      (
        await memoryClient(app, '2026-07-28').call('detach', {
          id: fileMemory,
          name: pdfName,
          sha256: files[0].sha256,
        })
      ).isError,
    ).not.toBe(true);
    await page.keyboard.press('Escape');
    await openForget(page);
    await confirmForget(page);
    await forgetArrived.promise;
    await page
      .getByRole('heading', { name: 'Another memory', exact: true })
      .waitFor();
    const before = reads.length;
    const response = page.waitForResponse((response) =>
      new URL(response.url()).pathname.includes('/files/'),
    );
    downloadGate.resolve();
    await (await response).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(reads.slice(before)).toEqual([]);
    const queries = await memoryQueries(page);
    try {
      expect(
        await queries.evaluate(
          (client, id) => client.getQueryData(['memory', id]) ?? null,
          fileMemory,
        ),
      ).toBeNull();
    } finally {
      await queries.dispose();
    }
    forgetGate.resolve();
    await page.getByText('Forgot File guide', { exact: true }).waitFor();
    expect(
      await page.locator(`[data-memory-row="${fileMemory}"]`).count(),
    ).toBe(0);
  } finally {
    downloadGate.resolve();
    forgetGate.resolve();
    await visit.close();
  }
});

it.each(['missing', 'unavailable'] as const)(
  'delivers a late %s result to the reopened drawer after A to B to A navigation',
  async (outcome) => {
    const gate = deferred();
    const arrived = deferred();
    const otherId = memoryId(602);
    const visit = await filesPage(browser, {
      configure: async (page, app) => {
        await seedMemories(app, [
          memoryFixture(602, {
            bucket: fileBucket,
            content: '# Another memory',
          }),
        ]);
        await page.route('**/api/memories/*/files/*', async (route) => {
          arrived.resolve();
          await gate.promise;
          await route.continue().catch(() => {});
        });
      },
    });
    try {
      const { page, app, files } = visit;
      await openFiles(page);
      const button = filesSheet(page).getByRole('button', {
        name: `Download ${files[0].name}`,
        exact: true,
      });
      await button.click();
      await arrived.promise;
      await page.keyboard.press('Escape');
      await page.locator(`[data-memory-row="${otherId}"]`).click();
      await page
        .getByRole('heading', { name: 'Another memory', exact: true })
        .waitFor();
      await page.locator(`[data-memory-row="${fileMemory}"]`).click();
      await page
        .getByRole('heading', { name: 'File guide', exact: true })
        .waitFor();
      await openFiles(page);
      expect(await button.getAttribute('aria-busy')).toBe('true');
      if (outcome === 'missing') {
        expect(
          (
            await memoryClient(app, '2026-07-28').call('detach', {
              id: fileMemory,
              name: files[0].name,
              sha256: files[0].sha256,
            })
          ).isError,
        ).not.toBe(true);
      } else {
        await (await app.mf.getR2Bucket('FILES')).delete(files[0].object_key);
      }
      gate.resolve();
      if (outcome === 'missing') await waitFileRows(page, 2);
      else await expect.poll(() => button.isEnabled()).toBe(true);
      const alert = filesSheet(page).getByRole('alert');
      expect(await alert.count()).toBe(1);
      expect(await alert.innerText()).toContain(
        outcome === 'missing'
          ? 'File not found.'
          : 'Could not download the file',
      );
      if (outcome === 'unavailable')
        expect(
          await alert
            .getByRole('button', { name: 'Try again', exact: true })
            .isEnabled(),
        ).toBe(true);
    } finally {
      gate.resolve();
      await visit.close();
    }
  },
);
