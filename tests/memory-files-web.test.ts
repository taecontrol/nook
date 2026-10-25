import { readFile } from 'node:fs/promises';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { auditRows } from './support/audit.ts';
import { deferred } from './support/machines.ts';
import { memoryClient } from './support/memory.ts';
import { digest, fileMemory, pdfName } from './support/memory-files.ts';
import {
  filesControl,
  filesPage,
  filesRows,
  filesSheet,
  openFiles,
  waitFileRows,
} from './support/memory-files-browser.ts';

let browser: Browser;
let closeBrowser: () => Promise<void>;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(() => closeBrowser?.());

it.each([
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
])(
  'E24: Files count sits beside History and the drawer lists newest-first metadata and full Details at $width px',
  async (viewport) => {
    const visit = await filesPage(browser, { viewport });
    try {
      const { page, files } = visit;
      const control = filesControl(page);
      expect(await control.count()).toBe(1);
      expect(await control.getAttribute('aria-label')).toBe('Files, 3');
      expect(await control.locator('svg').count()).toBe(1);
      expect(await control.locator('svg.lucide-paperclip').count()).toBe(1);
      const history = page.getByRole('button', {
        name: /^History /,
      });
      const position = await control.boundingBox();
      const historyPosition = await history.boundingBox();
      if (!position || !historyPosition)
        throw new Error('Files and History must be visible.');
      expect(
        await control.evaluate((element) =>
          element.nextElementSibling?.hasAttribute('data-memory-history'),
        ),
      ).toBe(true);
      const label = control.getByText('Files', { exact: true });
      expect(await label.isVisible()).toBe(viewport.width < 1024);
      if (viewport.width >= 1024) {
        expect(position.y).toBe(historyPosition.y);
        expect(position.x).toBeLessThan(historyPosition.x);
        await control.hover();
        await page
          .getByRole('tooltip', { name: 'Files', exact: true })
          .waitFor();
      }
      await openFiles(page);
      await waitFileRows(page, files.length);
      expect(
        await filesRows(page).evaluateAll((rows) =>
          rows.map((row) => row.getAttribute('data-file-row')),
        ),
      ).toEqual(files.toReversed().map((row) => row.name));
      for (const file of files) {
        const row = filesRows(page).filter({
          has: page.locator('[title]').filter({ hasText: file.name }),
        });
        const name = row
          .locator('[title]')
          .filter({ hasText: file.name })
          .first();
        expect(await name.getAttribute('title')).toBe(file.name);
        expect(
          await name.evaluate((el) => getComputedStyle(el).webkitLineClamp),
        ).toBe('3');
        expect(await row.locator('[data-slot="item-media"] svg').count()).toBe(
          1,
        );
        const text = await row.innerText();
        expect(text).toContain('application/pdf');
        expect(text).toContain(file.size > 1024 * 1024 ? '2.3 MiB' : '4 KiB');
        expect(text).toContain('Attached');
        expect(text).toContain('by LG16');
        expect(await row.locator('time').getAttribute('datetime')).toBe(
          file.attached_at,
        );
        await row.getByRole('button', { name: 'Details', exact: true }).click();
        const details = await row.innerText();
        expect(details).toContain(`${file.size.toLocaleString('en-US')} bytes`);
        expect(details).toContain(file.sha256);
        expect(details).toContain('Client (as reported)');
        expect(details).toContain('nook-acceptance');
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(viewport.width);
    } finally {
      await visit.close();
    }
  },
);
it.each(['hover', 'focus'] as const)(
  'E24/E29: Files is a separate lazy script requested on %s intent before the drawer opens',
  async (intent) => {
    const scripts: string[] = [];
    const visit = await filesPage(browser, {
      configure: async (page) => {
        page.on('request', (request) => {
          if (request.resourceType() === 'script') scripts.push(request.url());
        });
      },
    });
    try {
      await visit.page.waitForLoadState('networkidle');
      expect(
        scripts.filter((url) => /memory-files-sheet-.*\.js/.test(url)),
      ).toEqual([]);
      const loaded = visit.page.waitForResponse((response) =>
        /memory-files-sheet-.*\.js/.test(response.url()),
      );
      await filesControl(visit.page)[intent]();
      expect((await loaded).status()).toBe(200);
      expect(await filesSheet(visit.page).count()).toBe(0);
      await openFiles(visit.page);
      await waitFileRows(visit.page, 3);
      expect(
        scripts.filter((url) => /memory-files-sheet-.*\.js/.test(url)),
      ).toHaveLength(1);
      expect(
        scripts.filter((url) => /memory-history-sheet-.*\.js/.test(url)),
      ).toEqual([]);
    } finally {
      await visit.close();
    }
  },
);
it('E25: a pending owner download saves Unicode bytes under the file name, disables peers and audits owner/IP/country', async () => {
  const gate = deferred();
  const arrived = deferred();
  const visit = await filesPage(browser, {
    configure: async (page) => {
      await page.clock.install();
      await page.route('**/api/memories/*/files/*', async (route) => {
        arrived.resolve();
        await gate.promise;
        await route.continue().catch(() => {});
      });
    },
  });
  try {
    const { page, app, files } = visit;
    const file = files[1];
    await openFiles(page);
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    await page.evaluate(() => {
      const urls = Object.assign(URL, {
        created: [] as string[],
        revoked: [] as string[],
      });
      const create = URL.createObjectURL.bind(URL);
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        const url = create(blob);
        urls.created.push(url);
        return url;
      };
      URL.revokeObjectURL = (url) => {
        urls.revoked.push(url);
        revoke(url);
      };
    });
    const saved = page.waitForEvent('download');
    const button = filesSheet(page).getByRole('button', {
      name: `Download ${file.name}`,
      exact: true,
    });
    await button.click();
    await arrived.promise;
    expect(await button.getAttribute('aria-busy')).toBe('true');
    expect(await button.innerText()).toContain('Downloading…');
    for (const peer of await filesSheet(page)
      .getByRole('button', { name: /^Download / })
      .all())
      expect(await peer.isDisabled()).toBe(true);
    gate.resolve();
    const download = await saved;
    expect(download.suggestedFilename()).toBe(file.name);
    const path = await download.path();
    if (!path) throw new Error('Chromium did not save the file.');
    expect(digest(await readFile(path))).toBe(file.sha256);
    expect(
      (await auditRows(app)).filter((row) => row.outcome === 'file_downloaded'),
    ).toEqual([
      expect.objectContaining({
        memory_id: fileMemory,
        file_name: file.name,
        file_sha256: file.sha256,
        machine_id: null,
        machine_name: null,
        ip: '203.0.113.67',
        country: 'AR',
      }),
    ]);
    expect(await button.isEnabled()).toBe(true);
    expect(new URL(page.url()).pathname).toBe('/memory');
    const urls = () =>
      page.evaluate(() => {
        const tracked = URL as typeof URL & {
          created: string[];
          revoked: string[];
        };
        return { created: tracked.created, revoked: tracked.revoked };
      });
    expect((await urls()).created).toHaveLength(1);
    expect((await urls()).revoked).toEqual([]);
    await page.clock.runFor(1000);
    expect((await urls()).revoked).toEqual([]);
    await page.clock.fastForward(60_000);
    expect((await urls()).revoked).toEqual((await urls()).created);
  } finally {
    gate.resolve();
    await visit.close();
  }
});
it('E25: a genuine 404 names the missing file, refreshes detail and removes its row and final Files control', async () => {
  const visit = await filesPage(browser, { names: [pdfName] });
  try {
    const { page, app, files } = visit;
    await openFiles(page);
    const result = await memoryClient(app, '2026-07-28').call('detach', {
      id: fileMemory,
      name: pdfName,
      sha256: files[0].sha256,
    });
    expect(result.isError).not.toBe(true);
    const refreshed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/memories/${fileMemory}`,
    );
    await filesSheet(page)
      .getByRole('button', { name: `Download ${pdfName}`, exact: true })
      .click();
    await filesSheet(page)
      .getByText('File not found.', { exact: true })
      .waitFor();
    expect(await filesSheet(page).innerText()).toContain(pdfName);
    expect((await refreshed).status()).toBe(200);
    await waitFileRows(page, 0);
    // The open sheet hides the reader from the accessibility tree; close it
    // before asserting that the reader no longer offers Files.
    await page.keyboard.press('Escape');
    await expect.poll(() => filesSheet(page).count()).toBe(0);
    expect(await filesControl(page).count()).toBe(0);
    expect(
      (await auditRows(app)).filter((row) => row.outcome === 'file_downloaded'),
    ).toEqual([]);
  } finally {
    await visit.close();
  }
});
it('E25: a referenced missing R2 object produces an alert with Try again and a real restored download succeeds', async () => {
  const visit = await filesPage(browser, { names: [pdfName] });
  try {
    const { page, app, files } = visit;
    await openFiles(page);
    const bucket = await app.mf.getR2Bucket('FILES');
    await bucket.delete(files[0].object_key);
    await filesSheet(page)
      .getByRole('button', { name: `Download ${pdfName}`, exact: true })
      .click();
    const alert = filesSheet(page).getByRole('alert');
    await alert.waitFor();
    expect(await alert.innerText()).toContain('Could not download the file');
    expect(await alert.innerText()).toContain(pdfName);
    const retry = alert.getByRole('button', { name: 'Try again', exact: true });
    expect(await retry.isEnabled()).toBe(true);
    await waitFileRows(page, 1);
    await bucket.put(files[0].object_key, Buffer.alloc(2_418_734, 30));
    const saved = page.waitForEvent('download');
    await retry.click();
    const download = await saved;
    expect(download.suggestedFilename()).toBe(pdfName);
    const path = await download.path();
    if (!path) throw new Error('Chromium did not save the file.');
    expect(digest(await readFile(path))).toBe(files[0].sha256);
  } finally {
    await visit.close();
  }
});
