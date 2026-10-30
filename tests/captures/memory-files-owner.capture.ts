import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../../scripts/lib/test-browser.ts';
import { deferred } from '../support/machines.ts';
import { memoryClient } from '../support/memory.ts';
import { fileMemory } from '../support/memory-files.ts';
import {
  filesControl,
  filesPage,
  filesRows,
  filesSheet,
  openFiles,
  waitFileRows,
} from '../support/memory-files-browser.ts';
import {
  capturedFiles,
  capturedMemory,
  captureNeighbors,
  type FileCaptureState,
  fileCaptureStates,
} from './fixtures/memory-files.ts';

let browser: Browser;
let closeBrowser: (() => Promise<void>) | undefined;
const directory = resolve('.local/verification/screenshots');
beforeAll(async () => {
  await mkdir(directory, { recursive: true });
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(() => closeBrowser?.());

const matrix = fileCaptureStates.flatMap((state) =>
  (['light', 'dark'] as const).flatMap((theme) =>
    [
      { width: 1440, height: 900, name: 'desktop' },
      { width: 390, height: 844, name: 'phone' },
    ].map((size) => ({ state, theme, size })),
  ),
);

async function capture(page: Page, name: string, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    width,
  );
  const sheet = filesSheet(page);
  if (await sheet.count()) {
    expect(await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
    expect(await sheet.evaluate((el) => el.getBoundingClientRect().right)).toBe(
      width,
    );
  }
  await page.screenshot({
    path: resolve(directory, `memory-files-${name}.png`),
    animations: 'disabled',
  });
}

async function downloadState(
  visit: Awaited<ReturnType<typeof filesPage>>,
  state: FileCaptureState,
) {
  if (!state.startsWith('download-')) return;
  const { page, app, files } = visit;
  const file = files[0];
  if (state === 'download-missing') {
    const result = await memoryClient(app, '2026-07-28').call('detach', {
      id: fileMemory,
      name: file.name,
      sha256: file.sha256,
    });
    expect(result.isError).not.toBe(true);
  }
  if (state === 'download-unavailable')
    await (await app.mf.getR2Bucket('FILES')).delete(file.object_key);
  const button = filesSheet(page).getByRole('button', {
    name: `Download ${file.name}`,
    exact: true,
  });
  await button.click();
  if (state === 'download-pending') {
    await expect.poll(() => button.getAttribute('aria-busy')).toBe('true');
    expect(await button.isDisabled()).toBe(true);
  } else {
    await filesSheet(page).getByRole('alert').waitFor();
    await waitFileRows(page, state === 'download-missing' ? 0 : 1);
    if (state === 'download-missing') {
      await filesSheet(page)
        .getByText(/The list is up to date/)
        .waitFor();
      expect(await filesControl(page).count()).toBe(0);
    } else {
      expect(
        await filesSheet(page)
          .getByRole('button', { name: 'Try again', exact: true })
          .isEnabled(),
      ).toBe(true);
    }
  }
}

it.each(matrix)(
  'E28: capture $state at $size.name $theme against Files drawer C',
  async ({ state, theme, size }) => {
    const gate = deferred();
    const visit = await filesPage(browser, {
      viewport: size,
      colorScheme: theme,
      memory: capturedMemory,
      files: capturedFiles(state),
      configure: async (page, app) => {
        await captureNeighbors(app);
        await page.clock.setFixedTime(new Date('2026-10-22T18:00:00.000Z'));
        if (state === 'download-pending')
          await page.route('**/api/memories/*/files/*', async (route) => {
            await gate.promise;
            await route.continue().catch(() => {});
          });
      },
    });
    try {
      const { page, files } = visit;
      if (state === 'long-name')
        expect(Buffer.byteLength(files[0].name)).toBe(255);
      const name = `${state}--${size.name}-${theme}`;
      await filesControl(page).waitFor();
      await capture(page, `${name}--reader`, size.width);
      await openFiles(page);
      await waitFileRows(page, files.length);
      // Wait for the actual Sheet entrance before measuring its viewport edge.
      await expect
        .poll(async () => (await filesSheet(page).boundingBox())?.x)
        .toBe(size.width >= 640 ? size.width - 448 : 0);
      await downloadState(visit, state);
      await capture(page, `${name}--sheet`, size.width);
      if (state === 'long-name' || state === 'many-files') {
        const first = filesRows(page).first();
        await first
          .getByRole('button', { name: 'Details', exact: true })
          .click();
        await first.getByText('SHA-256', { exact: true }).waitFor();
        await capture(page, `${name}--details`, size.width);
      }
      if (state === 'many-files') {
        const last = filesRows(page)
          .last()
          .getByRole('button', { name: /^Download / });
        await last.scrollIntoViewIfNeeded();
        expect(await last.isVisible()).toBe(true);
        await capture(page, `${name}--sheet-end`, size.width);
      }
    } finally {
      gate.resolve();
      await visit.close();
    }
  },
  30_000,
);
