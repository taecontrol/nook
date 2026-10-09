import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { auditRows } from './support/audit.ts';
import { jsonRequest } from './support/authorizations.ts';
import { deferred } from './support/machines.ts';
import {
  openReveal,
  revealPage,
  revealPath,
  revealRequests,
  revealSecret,
  revealValue,
  setRevealValue,
  storageHasValue,
  valueField,
} from './support/reveal.ts';
import {
  createSecret,
  deleteSecret,
  listSecrets,
  secretInput,
  vaultRuntime,
} from './support/vault.ts';
import {
  createDraft,
  privateClientState,
  replaceDraft,
  secretRow,
} from './support/vault-browser.ts';
import { vaultCheckpoints } from './support/vault-checkpoints.ts';

let browser: Browser;
let closeBrowser: () => Promise<void>;
const screenshots = resolve('.local/verification/screenshots');
beforeAll(async () => {
  await mkdir(screenshots, { recursive: true });
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
});
it('E1/E8: selecting Reveal shows the exact read-only value and metadata with Copy/Close, without caching or persisting it', async () => {
  const visit = await revealPage(browser);
  try {
    const { page } = visit;
    const dialog = await openReveal(page);
    await valueField(page).waitFor();
    expect(await dialog.getByRole('heading').innerText()).toBe('STRIPE_KEY');
    expect(
      await dialog.locator('[data-slot="dialog-description"]').innerText(),
    ).toMatch(/^work\/acme\/STRIPE_KEY · Updated /);
    expect((await valueField(page).inputValue()) === revealValue).toBe(true);
    expect(await valueField(page).getAttribute('readonly')).not.toBeNull();
    expect(
      await dialog
        .getByRole('button', { name: 'Copy', exact: true })
        .isEnabled(),
    ).toBe(true);
    expect(
      await dialog.getByRole('button', { name: 'Close', exact: true }).count(),
    ).toBe(2);
    expect(
      (await privateClientState(page, [revealValue])).absentFromCache,
    ).toBe(true);
    expect(await storageHasValue(page, revealValue)).toBe(false);
    await dialog
      .getByRole('button', { name: 'Close', exact: true })
      .first()
      .click();
    await expect
      .poll(() => privateClientState(page, [revealValue]))
      .toEqual({ found: true, absentFromCache: true, absentFromDom: true });
    expect(await storageHasValue(page, revealValue)).toBe(false);
    expect(revealRequests(visit.requests)).toHaveLength(1);
  } finally {
    await visit.close();
  }
});
it.each([
  { width: 390, height: 844, multiline: true },
  { width: 1440, height: 900, multiline: true },
  { width: 390, height: 844, multiline: false },
  { width: 1440, height: 900, multiline: false },
])(
  'E2: a 64 KiB value preserves spaces/newlines and scrolls inside a bounded dialog ($width, multi-line: $multiline)',
  async ({ width, height, multiline }) => {
    const prefix = '  秘密🔐\n';
    const suffix = '  \n';
    const chunk = multiline ? 'synthetic-line\n' : 'x';
    const length = 65536 - Buffer.byteLength(prefix + suffix);
    const value =
      prefix +
      chunk.repeat(Math.ceil(length / chunk.length)).slice(0, length) +
      suffix;
    const visit = await revealPage(browser, {
      value,
      viewport: { width, height },
    });
    try {
      const { page } = visit;
      const dialog = await openReveal(page);
      await valueField(page).waitFor();
      expect((await valueField(page).inputValue()) === value).toBe(true);
      expect(
        await valueField(page).evaluate(
          (element) =>
            element.scrollHeight > element.clientHeight &&
            element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      const box = await dialog.boundingBox();
      expect(
        box !== null &&
          box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= width &&
          box.y + box.height <= height,
      ).toBe(true);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
    } finally {
      await visit.close();
    }
  },
);
it.each([
  { width: 390, height: 844, colorScheme: 'light' as const },
  { width: 390, height: 844, colorScheme: 'dark' as const },
  { width: 1440, height: 900, colorScheme: 'light' as const },
  { width: 1440, height: 900, colorScheme: 'dark' as const },
])(
  'E1/E2/E3: maximum accepted metadata uses the real reveal URL and keeps value/actions within the viewport ($width, $colorScheme)',
  async ({ width, height, colorScheme }) => {
    const bucket = Array.from({ length: 6 }, (_, index) =>
      String.fromCharCode(97 + index).repeat(32),
    ).join('/');
    const name = 'W'.repeat(64);
    const path = `${bucket}/${name}`;
    const value =
      '  synthetic maximum path\n' +
      'x'.repeat(65536 - Buffer.byteLength('  synthetic maximum path\n  \n')) +
      '  \n';
    const visit = await revealPage(browser, {
      start: `/vault?bucket=${encodeURIComponent(bucket)}`,
      viewport: { width, height },
      colorScheme,
      configure: async (_page, app) => {
        expect(
          (await jsonRequest(app, '/api/buckets', { path: bucket })).status,
        ).toBe(200);
        expect(
          (await createSecret(app, secretInput({ bucket, name, value })))
            .status,
        ).toBe(201);
      },
    });
    try {
      const { page } = visit;
      await secretRow(page, path).getByRole('button').waitFor();
      await page.screenshot({
        path: resolve(
          screenshots,
          `vault-max-path-${width}-${colorScheme}.png`,
        ),
        animations: 'disabled',
      });
      await secretRow(page, path).getByRole('button').click();
      const delivered = page.waitForResponse((response) =>
        new URL(response.url()).pathname.endsWith('/reveal'),
      );
      await page
        .getByRole('menuitem', { name: 'Reveal value…', exact: true })
        .click();
      expect((await delivered).status()).toBe(200);
      const dialog = page.getByRole('dialog', { name, exact: true });
      const field = valueField(page);
      await field.waitFor();
      expect((await field.inputValue()) === value).toBe(true);
      await page.screenshot({
        path: resolve(
          screenshots,
          `reveal-max-path-${width}-${colorScheme}.png`,
        ),
        animations: 'disabled',
      });
      expect(
        await dialog.locator('[data-slot="dialog-description"]').innerText(),
      ).toContain(`${path} · Updated `);
      expect(revealRequests(visit.requests)).toEqual([
        {
          method: 'POST',
          path: `/api/secrets/${encodeURIComponent(path)}/reveal`,
        },
      ]);
      expect(
        await field.evaluate(
          (element) =>
            element.scrollHeight > element.clientHeight &&
            element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      for (const control of [
        dialog,
        dialog.getByRole('button', { name: 'Copy', exact: true }),
        dialog.getByRole('button', { name: 'Close', exact: true }).first(),
        dialog.getByRole('button', { name: 'Close', exact: true }).last(),
        dialog.getByRole('link', { name: 'Audit', exact: true }),
      ]) {
        const box = await control.boundingBox();
        expect(
          box !== null &&
            box.x >= 0 &&
            box.y >= 0 &&
            box.x + box.width <= width &&
            box.y + box.height <= height,
        ).toBe(true);
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
      await dialog
        .getByRole('button', { name: 'Copied', exact: true })
        .waitFor();
      expect(
        (await page.evaluate(() => navigator.clipboard.readText())) === value,
      ).toBe(true);
      expect(await auditRows(visit.app)).toHaveLength(1);
      await dialog
        .getByRole('button', { name: 'Close', exact: true })
        .last()
        .click();
      await expect
        .poll(() => privateClientState(page, [value]))
        .toEqual({ found: true, absentFromCache: true, absentFromDom: true });
      expect(await storageHasValue(page, value)).toBe(false);
    } finally {
      await visit.close();
    }
  },
);
it('E3: Copy writes exact bytes and shows Copied/live feedback for three seconds; rejection gives destructive manual-copy guidance', async () => {
  const value = '  synthetic clipboard\n秘密🔐  \n';
  const visit = await revealPage(browser, { value });
  try {
    const { page } = visit;
    const dialog = await openReveal(page);
    await valueField(page).waitFor();
    await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
    await dialog.getByRole('button', { name: 'Copied', exact: true }).waitFor();
    expect(
      (await page.evaluate(() => navigator.clipboard.readText())) === value,
    ).toBe(true);
    const live = dialog.locator('[aria-live="polite"]');
    expect(await live.innerText()).toBe('Copied to the clipboard.');
    await page.waitForTimeout(1000);
    expect(await live.innerText()).toBe('Copied to the clipboard.');
    await expect.poll(() => live.innerText()).toBe('');
    expect(
      await dialog
        .getByRole('button', { name: 'Copy', exact: true })
        .isEnabled(),
    ).toBe(true);
    await page.evaluate(() => {
      navigator.clipboard.writeText = () =>
        Promise.reject(new Error('synthetic clipboard failure'));
    });
    await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect
      .poll(() => live.innerText())
      .toBe("Couldn't copy. Select the value and copy it yourself.");
    expect(await live.locator('span').getAttribute('class')).toContain(
      'text-destructive',
    );
    expect(await auditRows(visit.app)).toHaveLength(1);
  } finally {
    await visit.close();
  }
});
it('E2/E3: CR and CRLF retain exact 64 KiB in the raw readonly field, HTTP and real clipboard', async () => {
  const prefix = '  synthetic CR\rCRLF\r\n秘密🔐\r\n';
  const suffix = '  \r';
  const value =
    prefix + 'x'.repeat(65536 - Buffer.byteLength(prefix + suffix)) + suffix;
  const visit = await revealPage(browser, {
    value,
    viewport: { width: 390, height: 844 },
  });
  try {
    const response = await revealSecret(visit.app);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { value: string }).value === value).toBe(
      true,
    );
    const dialog = await openReveal(visit.page);
    const field = valueField(visit.page);
    await field.waitFor();
    expect(await field.getAttribute('readonly')).not.toBeNull();
    expect(
      await field.evaluate(
        (element, original) =>
          element.textContent === original &&
          (element as HTMLTextAreaElement).defaultValue === original,
        value,
      ),
    ).toBe(true);
    // Native textarea API values normalize newlines; its raw DOM value does not.
    expect((await field.inputValue()) === value.replace(/\r\n?/g, '\n')).toBe(
      true,
    );
    await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
    await dialog.getByRole('button', { name: 'Copied', exact: true }).waitFor();
    expect(
      (await visit.page.evaluate(() => navigator.clipboard.readText())) ===
        value,
    ).toBe(true);
    await dialog
      .getByRole('button', { name: 'Close', exact: true })
      .first()
      .click();
    await expect
      .poll(() => privateClientState(visit.page, [value]))
      .toEqual({ found: true, absentFromCache: true, absentFromDom: true });
    expect(await storageHasValue(visit.page, value)).toBe(false);
  } finally {
    await visit.close();
  }
});
it('E1/E7/E25: the stored updated date, monospace field, guidance and Audit link describe this secret', async () => {
  const visit = await revealPage(browser, {
    configure: async (_page, app) => {
      await (await app.mf.getD1Database('DB'))
        .prepare('UPDATE secrets SET updated_at=? WHERE name=?')
        .bind('2023-04-05T06:07:08.000Z', 'STRIPE_KEY')
        .run();
      expect(
        (await revealSecret(app, 'personal/finances/PLAID_SECRET')).status,
      ).toBe(200);
    },
  });
  try {
    const { page } = visit;
    const sheet = await createDraft(page);
    expect(await sheet.locator('#secret-value-feedback').innerText()).toContain(
      'Once saved, it is encrypted; reveal it from the list when you need it.',
    );
    await page.keyboard.press('Escape');
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
    const dialog = await openReveal(page);
    await valueField(page).waitFor();
    expect(
      await dialog.locator('[data-slot="dialog-description"]').innerText(),
    ).toBe('work/acme/STRIPE_KEY · Updated Apr 5, 2023');
    expect(
      await valueField(page).evaluate(
        (element) => getComputedStyle(element).fontFamily,
      ),
    ).toMatch(/monospace/);
    await dialog
      .getByText(
        'This reveal is recorded in Audit. The value is hidden again when you close this.',
        { exact: true },
      )
      .waitFor();
    await dialog.getByRole('link', { name: 'Audit', exact: true }).click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('secret'))
      .toBe(revealPath);
    const entries = page.locator('[data-entry]');
    await expect.poll(() => entries.count()).toBe(1);
    expect(await entries.first().innerText()).toContain('STRIPE_KEY');
    expect(await entries.first().innerText()).not.toContain('PLAID_SECRET');
    expect(await auditRows(visit.app)).toHaveLength(2);
  } finally {
    await visit.close();
  }
});
it('E3: clipboard feedback is reset at three seconds and restarts after another real copy', async () => {
  const visit = await revealPage(browser, {
    configure: async (page) => {
      await page.clock.install({ time: new Date('2026-10-09T12:00:00Z') });
    },
  });
  try {
    const { page } = visit;
    const dialog = await openReveal(page);
    await valueField(page).waitFor();
    await page.evaluate(() => {
      const writeText = navigator.clipboard.writeText.bind(navigator.clipboard);
      let writes = 0;
      navigator.clipboard.writeText = async (value) => {
        await writeText(value);
        document.documentElement.dataset.clipboardWrites = String(++writes);
      };
    });
    const pauseTime = await page.evaluate(() => Date.now() + 60_000);
    await page.clock.pauseAt(pauseTime);
    const live = dialog.locator('[aria-live="polite"]');
    await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
    await dialog.getByRole('button', { name: 'Copied', exact: true }).waitFor();
    expect(
      (await page.evaluate(() => navigator.clipboard.readText())) ===
        revealValue,
    ).toBe(true);
    await page.clock.runFor(2900);
    expect(await live.innerText()).toBe('Copied to the clipboard.');
    expect(
      await dialog.getByRole('button', { name: 'Copied', exact: true }).count(),
    ).toBe(1);
    await page.clock.runFor(200);
    await expect.poll(() => live.innerText()).toBe('');
    await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect
      .poll(() => page.locator('html').getAttribute('data-clipboard-writes'))
      .toBe('2');
    await dialog.getByRole('button', { name: 'Copied', exact: true }).waitFor();
    await page.clock.runFor(2000);
    await dialog.getByRole('button', { name: 'Copied', exact: true }).click();
    await expect
      .poll(() => page.locator('html').getAttribute('data-clipboard-writes'))
      .toBe('3');
    await page.clock.runFor(1001);
    expect(await live.innerText()).toBe('Copied to the clipboard.');
    await page.clock.runFor(1899);
    expect(await live.innerText()).toBe('Copied to the clipboard.');
    await page.clock.runFor(200);
    await expect.poll(() => live.innerText()).toBe('');
    expect(await auditRows(visit.app)).toHaveLength(1);
  } finally {
    await visit.close();
  }
});
it('E5: a held genuine reveal request shows skeleton/Revealing and disabled Copy, with no automatic retry', async () => {
  const gate = deferred();
  const visit = await revealPage(browser, {
    configure: async (page) => {
      await page.route('**/api/secrets/*/reveal', async (route) => {
        await gate.promise;
        await route.continue().catch(() => {});
      });
    },
  });
  try {
    const dialog = await openReveal(visit.page);
    await dialog.getByText('Revealing…', { exact: true }).waitFor();
    expect(
      await dialog.locator('[data-slot="skeleton"]').count(),
    ).toBeGreaterThan(0);
    expect(
      await dialog
        .getByRole('button', { name: 'Copy', exact: true })
        .isEnabled(),
    ).toBe(false);
    expect(await valueField(visit.page).count()).toBe(0);
    expect(revealRequests(visit.requests)).toHaveLength(1);
    expect(await auditRows(visit.app)).toEqual([]);
    gate.resolve();
    await valueField(visit.page).waitFor();
    expect(revealRequests(visit.requests)).toHaveLength(1);
  } finally {
    gate.resolve();
    await visit.close();
  }
});
it.each(['Close', 'Escape', 'x', 'outside'])(
  'E6/E8: %s removes the value and reopening makes a new request/entry',
  async (method) => {
    const visit = await revealPage(browser);
    try {
      const { page } = visit;
      const dialog = await openReveal(page);
      await valueField(page).waitFor();
      if (method === 'Close')
        await dialog
          .getByRole('button', { name: 'Close', exact: true })
          .first()
          .click();
      else if (method === 'Escape') await page.keyboard.press('Escape');
      else if (method === 'x')
        await dialog.locator('[data-slot="dialog-close"]').click();
      else await page.mouse.click(5, 80);
      await expect
        .poll(() => privateClientState(page, [revealValue]))
        .toEqual({ found: true, absentFromCache: true, absentFromDom: true });
      expect(await storageHasValue(page, revealValue)).toBe(false);
      await openReveal(page);
      await valueField(page).waitFor();
      expect(revealRequests(visit.requests)).toHaveLength(2);
      expect(await auditRows(visit.app)).toHaveLength(2);
    } finally {
      await visit.close();
    }
  },
);
it.each(['Audit', 'Back', 'sidebar', 'bucket-back'])(
  'E7: %s navigation closes the dialog, clears the value and does not restore it on return',
  async (destination) => {
    const visit = await revealPage(browser, { start: '/' });
    try {
      const { page } = visit;
      await page.getByRole('link', { name: 'Vault', exact: true }).click();
      await page
        .getByRole('list', { name: 'Buckets', exact: true })
        .locator('[data-path="work/acme"]')
        .getByRole('link')
        .click();
      const dialog = await openReveal(page);
      await valueField(page).waitFor();
      if (destination === 'Audit')
        await dialog.getByRole('link', { name: 'Audit', exact: true }).click();
      else if (destination === 'sidebar') {
        // A programmatic link activation tests a route change while the modal is open.
        await page
          .locator('a[href="/buckets"]')
          .first()
          .evaluate((element) => (element as HTMLElement).click());
      } else await page.goBack();
      await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
      await expect
        .poll(() => privateClientState(page, [revealValue]))
        .toEqual({ found: true, absentFromCache: true, absentFromDom: true });
      expect(await storageHasValue(page, revealValue)).toBe(false);
      if (destination === 'Back' || destination === 'bucket-back')
        await page.goForward();
      else await page.goBack();
      await secretRow(page, revealPath).waitFor();
      expect(await valueField(page).count()).toBe(0);
      expect(revealRequests(visit.requests)).toHaveLength(1);
    } finally {
      await visit.close();
    }
  },
);
it.each([
  'deleted',
  'missing-key',
  'other-key',
  'read-failure',
  'audit-failure',
])(
  'E9–E12: %s shows the safe error with Try again and disabled Copy, without a value or entry',
  async (kind) => {
    const visit = await revealPage(browser);
    try {
      const { page, app } = visit;
      await secretRow(page, revealPath).waitFor();
      const db = await app.mf.getD1Database('DB');
      if (kind === 'deleted') {
        const secret = (await listSecrets(app)).find(
          (item) => item.path === revealPath,
        )!;
        await deleteSecret(app, revealPath, secret.version);
      } else if (kind === 'missing-key')
        await app.setBindings({ ...app.bindings, VAULT_KEY: '' });
      else if (kind === 'other-key')
        await db
          .prepare(
            "UPDATE secrets SET key_id='0000000000000000' WHERE name='STRIPE_KEY'",
          )
          .run();
      else if (kind === 'read-failure')
        await db
          .prepare('ALTER TABLE secrets RENAME TO unavailable_secrets')
          .run();
      else
        await db
          .prepare(
            "CREATE TRIGGER reveal_failure BEFORE INSERT ON audit_entries BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END",
          )
          .run();
      const dialog = await openReveal(page);
      await dialog
        .getByRole('button', { name: 'Try again', exact: true })
        .waitFor();
      const message =
        kind === 'deleted'
          ? 'Secret not found.'
          : kind === 'missing-key'
            ? 'This installation has no VAULT_KEY. Add it as a Worker secret, then try again.'
            : kind === 'other-key'
              ? 'Cannot open a secret encrypted with key 0000000000000000.'
              : "Couldn't reveal the value. Try again in a moment.";
      expect(await dialog.innerText()).toContain(message);
      expect(
        await dialog
          .getByRole('button', { name: 'Copy', exact: true })
          .isEnabled(),
      ).toBe(false);
      expect(await valueField(page).count()).toBe(0);
      expect(revealRequests(visit.requests)).toHaveLength(1);
      expect(await auditRows(app)).toEqual([]);
      expect(
        (await privateClientState(page, [revealValue])).absentFromDom,
      ).toBe(true);
      expect(await storageHasValue(page, revealValue)).toBe(false);
      // A persistent failure gets exactly one new request only when explicitly retried.
      await dialog
        .getByRole('button', { name: 'Try again', exact: true })
        .click();
      await dialog
        .getByRole('button', { name: 'Try again', exact: true })
        .waitFor();
      expect(revealRequests(visit.requests)).toHaveLength(2);
      expect(await auditRows(app)).toEqual([]);
    } finally {
      await visit.close();
    }
  },
);
it('E13: a committed audit with a lost response shows failure; explicit retry makes a second real reveal', async () => {
  let lose = false;
  let statements = 0;
  const app = await vaultCheckpoints(
    async (label) => {
      if (label === '/statement') statements++;
      return !(lose && label === '/after-statement' && statements === 2);
    },
    undefined,
    true,
    { observeStatements: true },
  );
  const visit = await revealPage(browser, { app });
  try {
    await secretRow(visit.page, revealPath).waitFor();
    statements = 0;
    lose = true;
    const dialog = await openReveal(visit.page);
    await dialog
      .getByRole('button', { name: 'Try again', exact: true })
      .waitFor();
    expect(await dialog.innerText()).toContain(
      "Couldn't reveal the value. Try again in a moment.",
    );
    expect(await valueField(visit.page).count()).toBe(0);
    expect(await auditRows(app)).toHaveLength(1);
    expect(revealRequests(visit.requests)).toHaveLength(1);
    lose = false;
    statements = 0;
    await dialog
      .getByRole('button', { name: 'Try again', exact: true })
      .click();
    await valueField(visit.page).waitFor();
    expect((await valueField(visit.page).inputValue()) === revealValue).toBe(
      true,
    );
    expect(await auditRows(app)).toHaveLength(2);
    expect(revealRequests(visit.requests)).toHaveLength(2);
  } finally {
    lose = false;
    await visit.close();
  }
});
it('E5/E11: an explicit held retry resets pending UI and recovers after the D1 failure is repaired', async () => {
  const gate = deferred();
  let requests = 0;
  const visit = await revealPage(browser, {
    configure: async (page) => {
      await page.route('**/api/secrets/*/reveal', async (route) => {
        if (++requests === 2) await gate.promise;
        await route.continue().catch(() => {});
      });
    },
  });
  try {
    const { page } = visit;
    await secretRow(page, revealPath).waitFor();
    await (await visit.app.mf.getD1Database('DB'))
      .prepare('ALTER TABLE secrets RENAME TO unavailable_secrets')
      .run();
    const dialog = await openReveal(page);
    await dialog
      .getByRole('button', { name: 'Try again', exact: true })
      .waitFor();
    await (await visit.app.mf.getD1Database('DB'))
      .prepare('ALTER TABLE unavailable_secrets RENAME TO secrets')
      .run();
    await dialog
      .getByRole('button', { name: 'Try again', exact: true })
      .click();
    await expect.poll(() => requests).toBe(2);
    await dialog.getByText('Revealing…', { exact: true }).waitFor();
    expect(
      await dialog
        .getByRole('button', { name: 'Try again', exact: true })
        .count(),
    ).toBe(0);
    expect(
      await dialog
        .getByRole('button', { name: 'Copy', exact: true })
        .isEnabled(),
    ).toBe(false);
    expect(await valueField(page).count()).toBe(0);
    expect(await auditRows(visit.app)).toEqual([]);
    gate.resolve();
    await valueField(page).waitFor();
    expect((await valueField(page).inputValue()) === revealValue).toBe(true);
    expect(revealRequests(visit.requests)).toHaveLength(2);
    expect(await auditRows(visit.app)).toHaveLength(1);
  } finally {
    gate.resolve();
    await visit.close();
  }
});
it('E6/E7: closing an in-flight reveal and navigating away cannot restore its late response', async () => {
  const gate = deferred();
  const committed = deferred();
  const visit = await revealPage(browser, {
    configure: async (page) => {
      await page.route('**/api/secrets/*/reveal', async (route) => {
        const response = await route.fetch();
        committed.resolve();
        await gate.promise;
        await route.fulfill({ response }).catch(() => {});
      });
    },
  });
  try {
    const dialog = await openReveal(visit.page);
    await committed.promise;
    expect(await auditRows(visit.app)).toHaveLength(1);
    await dialog
      .getByRole('button', { name: 'Close', exact: true })
      .first()
      .click();
    await visit.page.getByRole('link', { name: 'Audit', exact: true }).click();
    gate.resolve();
    await visit.page.waitForLoadState('networkidle');
    await visit.page.goBack();
    await secretRow(visit.page, revealPath).waitFor();
    expect(await valueField(visit.page).count()).toBe(0);
    expect(
      (await privateClientState(visit.page, [revealValue])).absentFromCache,
    ).toBe(true);
  } finally {
    gate.resolve();
    await visit.close();
  }
});
it('E6/E8: closing and reopening before the old response arrives preserves only the new dialog value', async () => {
  const gate = deferred();
  const committed = deferred();
  let requests = 0;
  const replacement = 'synthetic-new-dialog-value';
  const visit = await revealPage(browser, {
    configure: async (page) => {
      await page.route('**/api/secrets/*/reveal', async (route) => {
        if (++requests !== 1) {
          await route.continue();
          return;
        }
        const response = await route.fetch();
        committed.resolve();
        await gate.promise;
        await route.fulfill({ response }).catch(() => {});
      });
    },
  });
  try {
    const { page } = visit;
    const first = await openReveal(page);
    await committed.promise;
    await first
      .getByRole('button', { name: 'Close', exact: true })
      .first()
      .click();
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
    await setRevealValue(visit.app, replacement);
    const reopened = await openReveal(page);
    await valueField(page).waitFor();
    expect((await valueField(page).inputValue()) === replacement).toBe(true);
    gate.resolve();
    await page.waitForLoadState('networkidle');
    expect((await valueField(page).inputValue()) === replacement).toBe(true);
    expect((await privateClientState(page, [revealValue])).absentFromDom).toBe(
      true,
    );
    expect(
      (await privateClientState(page, [revealValue, replacement]))
        .absentFromCache,
    ).toBe(true);
    expect(revealRequests(visit.requests)).toHaveLength(2);
    expect(await auditRows(visit.app)).toHaveLength(2);
    await reopened
      .getByRole('button', { name: 'Close', exact: true })
      .first()
      .click();
    await expect
      .poll(() => privateClientState(page, [revealValue, replacement]))
      .toEqual({ found: true, absentFromCache: true, absentFromDom: true });
  } finally {
    gate.resolve();
    await visit.close();
  }
});
it('E21: hover/focus on the menu and Reveal item never requests a value or writes audit; selecting does', async () => {
  const visit = await revealPage(browser);
  try {
    const { page } = visit;
    const trigger = secretRow(page, revealPath).getByRole('button');
    await trigger.hover();
    await trigger.focus();
    await trigger.click();
    const action = page.getByRole('menuitem', {
      name: 'Reveal value…',
      exact: true,
    });
    await action.hover();
    await action.focus();
    await page.waitForLoadState('networkidle');
    expect(revealRequests(visit.requests)).toEqual([]);
    expect(await auditRows(visit.app)).toEqual([]);
    await action.press('Enter');
    await valueField(page).waitFor();
    expect(revealRequests(visit.requests)).toHaveLength(1);
    expect(await auditRows(visit.app)).toHaveLength(1);
  } finally {
    await visit.close();
  }
});
it('E22: Reveal is disabled during a real write, and the saving row has no menu', async () => {
  const gate = deferred();
  const visit = await revealPage(browser, {
    configure: async (page) => {
      await page.route('**/api/secrets', async (route) => {
        if (route.request().method() === 'POST') await gate.promise;
        await route.continue().catch(() => {});
      });
    },
  });
  try {
    const { page } = visit;
    const sheet = await createDraft(page);
    await sheet
      .getByRole('button', { name: 'Save secret', exact: true })
      .click();
    await secretRow(page, 'work/acme/RESEND_API_KEY').waitFor();
    expect(
      await secretRow(page, 'work/acme/RESEND_API_KEY')
        .getByRole('button')
        .count(),
    ).toBe(0);
    await secretRow(page, revealPath).getByRole('button').click();
    const action = page.getByRole('menuitem', {
      name: 'Reveal value…',
      exact: true,
    });
    expect(await action.isEnabled()).toBe(false);
    await action.press('Enter');
    expect(revealRequests(visit.requests)).toEqual([]);
    expect(await page.getByRole('dialog').count()).toBe(0);
    await page.keyboard.press('Escape');
    gate.resolve();
    await page.getByRole('alert').filter({ hasText: 'Secret saved' }).waitFor();
    await openReveal(page);
    await valueField(page).waitFor();
  } finally {
    gate.resolve();
    await visit.close();
  }
});
it('E22: a saving replacement row has no menu after the sheet has completely closed', async () => {
  const gate = deferred();
  const visit = await revealPage(browser, {
    configure: async (page) => {
      await page.route('**/api/secrets/*', async (route) => {
        if (route.request().method() === 'PUT') await gate.promise;
        await route.continue().catch(() => {});
      });
    },
  });
  try {
    await replaceDraft(visit.page);
    await visit.page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Replace value', exact: true })
      .click();
    await expect.poll(() => visit.page.getByRole('dialog').count()).toBe(0);
    const row = secretRow(visit.page, revealPath);
    await expect.poll(() => row.innerText()).toContain('Saving…');
    expect(await row.locator('button').count()).toBe(0);
    expect(revealRequests(visit.requests)).toEqual([]);
    gate.resolve();
    await expect.poll(() => row.getByRole('button').count()).toBe(1);
  } finally {
    gate.resolve();
    await visit.close();
  }
});
it('E25: Vault header, fresh state and secret sheet explain encrypted values and owner reveals', async () => {
  const visit = await revealPage(browser);
  try {
    const { page } = visit;
    await secretRow(page, revealPath).waitFor();
    expect(await page.locator('h1').locator('../..').innerText()).toContain(
      'every reveal is recorded in Audit',
    );
    const sheet = await createDraft(page);
    expect(await sheet.innerText()).not.toMatch(/never shows|never shown/);
    expect(await sheet.innerText()).toContain('reveal it from the list');
  } finally {
    await visit.close();
  }
  const fresh = await vaultRuntime();
  const empty = await revealPage(browser, {
    app: fresh,
    configure: async (_page, app) => {
      await (await app.mf.getD1Database('DB'))
        .prepare('DELETE FROM secrets')
        .run();
    },
  });
  try {
    await empty.page.getByText('No secrets yet', { exact: true }).waitFor();
    expect(
      await empty.page.locator('[data-slot="empty-description"]').innerText(),
    ).not.toMatch(/never shows|never shown/);
  } finally {
    await empty.close();
  }
});
