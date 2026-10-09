import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { auditRows } from './support/audit.ts';
import { deferred } from './support/machines.ts';
import {
  openReveal,
  revealPage,
  revealPath,
  revealRequests,
  revealValue,
  storageHasValue,
  valueField,
} from './support/reveal.ts';
import { deleteSecret, listSecrets, vaultRuntime } from './support/vault.ts';
import {
  createDraft,
  privateClientState,
  secretRow,
} from './support/vault-browser.ts';
import { vaultCheckpoints } from './support/vault-checkpoints.ts';

let browser: Browser;
let closeBrowser: () => Promise<void>;
beforeAll(async () => {
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
    true,
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
