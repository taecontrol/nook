import type { Browser, Page } from 'playwright';
import { expect } from 'vitest';
import {
  fileMemory,
  pdfName,
  seedFile,
  seedFileMemory,
} from './memory-files.ts';
import { type FilesRuntime, filesRuntime } from './memory-files-runtime.ts';

export const filesControl = (page: Page) =>
  page.getByRole('button', { name: /^Files[, ]+\d/ });
export const filesSheet = (page: Page) =>
  page.getByRole('dialog', { name: 'Files', exact: true });
export const filesRows = (page: Page) =>
  filesSheet(page).locator('[data-file-row]');
export async function filesPage(
  browser: Browser,
  options: {
    names?: string[];
    viewport?: { width: number; height: number };
    colorScheme?: 'light' | 'dark';
    configure?: (page: Page, app: FilesRuntime) => Promise<void>;
  } = {},
) {
  const app = await filesRuntime();
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1440, height: 900 },
    colorScheme: options.colorScheme ?? 'light',
    acceptDownloads: true,
    locale: 'en-US',
    extraHTTPHeaders: { 'CF-Connecting-IP': '203.0.113.67' },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  try {
    await seedFileMemory(app);
    const files = [];
    const names = options.names ?? [
      pdfName,
      'diagrama de flujo débito inmediato.pdf',
      `${'é'.repeat(125)}a.pdf`,
    ];
    for (const [index, name] of names.entries())
      files.push(
        await seedFile(app, {
          name,
          bytes: Buffer.alloc(index === 0 ? 2_418_734 : 4096, index + 30),
          attachedAt: new Date(Date.UTC(2026, 9, 22, 14, index)).toISOString(),
        }),
      );
    await app.setBindings(app.bindings, { cf: { country: 'AR' } });
    await options.configure?.(page, app);
    await page.goto(
      `${app.origin}/memory?bucket=work/mamasan&memory=${fileMemory}`,
    );
    await page.getByRole('article', { name: 'Memory detail' }).waitFor();
    return {
      app,
      context,
      page,
      files,
      close: async () => {
        try {
          await context.close();
        } finally {
          await app.close();
        }
      },
    };
  } catch (error) {
    await context.close();
    await app.close();
    throw error;
  }
}
export async function openFiles(page: Page) {
  await filesControl(page).click();
  await filesSheet(page).waitFor();
}
export async function waitFileRows(page: Page, count: number) {
  await expect.poll(() => filesRows(page).count()).toBe(count);
}
