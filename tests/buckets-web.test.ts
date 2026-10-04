import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { invalidPaths } from './support/bucket-paths.ts';
import {
  bucketPage,
  closeBrowserPage,
  deepBuckets,
  typicalBuckets,
} from './support/buckets-browser.ts';
import { runtime, type TestRuntime } from './support/runtime.ts';

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

let browser: Browser;
let app: TestRuntime;
beforeAll(async () => {
  app = await runtime({ bindings: { LOCAL_OWNER: 'synthetic-owner' } });
  await app.setBindings({
    LOCAL_OWNER: 'synthetic-owner',
    LOCAL_ORIGIN: app.origin,
  });
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await app?.close();
});
const row = (page: import('playwright').Page, path: string) =>
  page.locator(`[data-path="${path}"]`);

async function withRealBuckets(
  visit: (
    page: Page,
    local: TestRuntime,
    requests: { method: string; url: string }[],
  ) => Promise<void>,
) {
  const local = await runtime({ bindings: { LOCAL_OWNER: 'synthetic-owner' } });
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests: { method: string; url: string }[] = [];
  page.on('request', (request) =>
    requests.push({ method: request.method(), url: request.url() }),
  );
  try {
    await local.setBindings({
      LOCAL_OWNER: 'synthetic-owner',
      LOCAL_ORIGIN: local.origin,
    });
    const db = await local.mf.getD1Database('DB');
    await db.batch(
      typicalBuckets.map((bucket) =>
        db
          .prepare(
            'INSERT INTO buckets VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET created_at=excluded.created_at',
          )
          .bind(bucket.path, bucket.createdAt),
      ),
    );
    await page.goto(`${local.origin}/buckets`);
    await row(page, 'work').waitFor();
    await visit(page, local, requests);
  } finally {
    await closeBrowserPage(page, context);
    await local.close();
  }
}

it('E14: invalid paths show exact field feedback and never issue a write; a preview lists all missing buckets', async () => {
  const { page, context, requests } = await bucketPage(browser, app.origin);
  try {
    await expect
      .poll(() =>
        page.getByRole('textbox', { name: 'New bucket path' }).count(),
      )
      .toBe(1);
    const field = page.getByRole('textbox', { name: 'New bucket path' });
    for (const [path, message] of invalidPaths) {
      await field.fill(path);
      if (path && path !== 'work/')
        await expect
          .poll(() => page.locator('#bucket-path-feedback').innerText())
          .toBe(message);
      await field.press('Enter');
      await expect
        .poll(() => page.locator('#bucket-path-feedback').innerText())
        .toBe(message);
    }
    expect(
      requests.filter((request) => request.method === 'POST'),
    ).toHaveLength(0);
    await field.fill('clients/acme/website');
    await expect
      .poll(() =>
        page.getByRole('list', { name: 'Buckets to create' }).innerText(),
      )
      .toBe('clients\nclients/acme\nclients/acme/website');
    for (const path of ['clients', 'clients/acme', 'clients/acme/website'])
      expect(await row(page, path).innerText()).toContain('new');
    expect(
      await page
        .locator(
          'li[data-bucket="clients"] ul li[data-bucket="clients/acme"] ul [data-path="clients/acme/website"]',
        )
        .count(),
    ).toBe(1);
    await field.fill('work');
    await expect.poll(() => row(page, 'work').innerText()).toContain('exists');
    expect(await page.locator('#bucket-path-feedback').innerText()).toContain(
      'already exists',
    );
    await field.press('/');
    expect(await field.inputValue()).toBe('work/');
    expect(await page.locator('#bucket-path-feedback').innerText()).toBe(
      'Type the next level inside work.',
    );
    await field.press('Enter');
    expect(await page.locator('#bucket-path-feedback').innerText()).toBe(
      'Separate segments with a single /, with none at the start or end.',
    );
  } finally {
    await closeBrowserPage(page, context);
  }
});

it.each([200, 503])(
  'E15: create is optimistic before HTTP %s and failure restores the path',
  async (status) => {
    const { page, context, requests } = await bucketPage(browser, app.origin);
    let finish = () => {};
    const waiting = new Promise<void>((accept) => {
      finish = accept;
    });
    const recovery = deferred();
    let responded = false;
    await page.route('**/api/buckets', async (route) => {
      if (route.request().method() === 'POST') {
        await waiting;
        responded = true;
        return route.fulfill({
          status,
          json:
            status === 200
              ? { path: 'work/acme', created: true, createdAncestors: [] }
              : { _tag: 'ServiceUnavailable' },
        });
      }
      if (responded) {
        await recovery.promise;
        return route.fulfill({
          json: {
            buckets:
              status === 200
                ? [
                    ...typicalBuckets,
                    {
                      path: 'work/acme',
                      createdAt: '2026-10-04T00:00:00.000Z',
                    },
                  ]
                : typicalBuckets,
          },
        });
      }
      return route.fallback();
    });
    try {
      await expect.poll(() => row(page, 'work').count()).toBe(1);
      const field = page.getByRole('textbox', { name: 'New bucket path' });
      await field.fill('work/acme');
      await field.press('Enter');
      await expect
        .poll(() => row(page, 'work/acme').innerText())
        .toBe('acme');
      expect(await field.inputValue()).toBe('');
      expect(
        await page
          .getByRole('button', {
            name: 'Actions for work/acme',
            exact: true,
          })
          .count(),
      ).toBe(0);
      finish();
      await expect
        .poll(
          () =>
            requests.filter(
              (r) => r.method === 'GET' && r.url.endsWith('/api/buckets'),
            ).length,
        )
        .toBe(2);
      if (status === 503)
        await expect.poll(() => row(page, 'work/acme').count()).toBe(0);
      recovery.resolve();
      if (status === 503) {
        await expect
          .poll(() => page.getByRole('alert').innerText())
          .toContain("Couldn't create work/acme");
        expect(await field.inputValue()).toBe('work/acme');
        expect(await row(page, 'work/acme').innerText()).toContain('new');
        expect(await page.getByRole('alert').innerText()).toContain('(503)');
      }
      await expect
        .poll(
          () =>
            requests.filter(
              (r) => r.method === 'GET' && r.url.endsWith('/api/buckets'),
            ).length,
        )
        .toBe(2);
    } finally {
      finish();
      recovery.resolve();
      await closeBrowserPage(page, context);
    }
  },
);
it.each([204, 503, 409])(
  'E15: delete is optimistic before HTTP %s and failures roll back and refetch',
  async (status) => {
    const { page, context, requests } = await bucketPage(browser, app.origin);
    let finish = () => {};
    const waiting = new Promise<void>((accept) => {
      finish = accept;
    });
    const recovery = deferred();
    let responded = false;
    await page.route('**/api/buckets/**', async (route) => {
      await waiting;
      responded = true;
      return route.fulfill({
        status,
        ...(status === 204
          ? {}
          : {
              json: {
                _tag:
                  status === 409 ? 'BucketHasChildren' : 'ServiceUnavailable',
                message: 'Delete its child buckets first.',
              },
            }),
      });
    });
    await page.route('**/api/buckets', async (route) => {
      if (!responded) return route.fallback();
      await recovery.promise;
      return route.fulfill({
        json: {
          buckets:
            status === 204
              ? typicalBuckets.filter(
                  (bucket) => bucket.path !== 'work/taecontrol/nook',
                )
              : typicalBuckets,
        },
      });
    });
    try {
      await expect
        .poll(() => row(page, 'work/taecontrol/nook').count())
        .toBe(1);
      await page
        .getByRole('button', {
          name: 'Actions for work/taecontrol/nook',
          exact: true,
        })
        .click();
      await page.getByRole('menuitem', { name: 'Delete bucket…' }).click();
      await page
        .getByRole('button', { name: 'Delete bucket', exact: true })
        .click();
      await expect
        .poll(() => row(page, 'work/taecontrol/nook').count())
        .toBe(0);
      await expect
        .poll(() =>
          page
            .getByRole('button', { name: 'Actions for me', exact: true })
            .evaluate((button) => button === document.activeElement),
        )
        .toBe(true);
      finish();
      if (status !== 204) {
        await expect
          .poll(() => row(page, 'work/taecontrol/nook').count())
          .toBe(1);
      }
      await expect
        .poll(
          () =>
            requests.filter(
              (r) => r.method === 'GET' && r.url.endsWith('/api/buckets'),
            ).length,
        )
        .toBe(2);
      recovery.resolve();
      if (status !== 204) {
        await expect
          .poll(() => page.getByRole('alert').innerText())
          .toContain(
            status === 409
              ? 'Delete its child buckets first.'
              : "Couldn't delete work/taecontrol/nook",
          );
        if (status === 503)
          expect(await page.getByRole('alert').innerText()).toContain('(503)');
      }
      await expect
        .poll(
          () =>
            requests.filter(
              (r) => r.method === 'GET' && r.url.endsWith('/api/buckets'),
            ).length,
        )
        .toBe(2);
    } finally {
      finish();
      recovery.resolve();
      await closeBrowserPage(page, context);
    }
  },
);
it.each(['hover', 'focus'])(
  'E16: %s on the Buckets link preloads the route and one query, reused by navigation',
  async (action) => {
    const { page, context, requests } = await bucketPage(browser, app.origin, {
      start: '/',
    });
    try {
      await expect
        .poll(() =>
          page.getByRole('link', { name: 'Buckets', exact: true }).count(),
        )
        .toBe(1);
      const link = page.getByRole('link', { name: 'Buckets', exact: true });
      expect(
        requests.filter((r) => r.url.endsWith('/api/buckets')),
      ).toHaveLength(0);
      if (action === 'hover') await link.hover();
      else await link.focus();
      await expect
        .poll(
          () => requests.filter((r) => r.url.endsWith('/api/buckets')).length,
        )
        .toBe(1);
      expect(requests.some((r) => /buckets.*\.js/.test(r.url))).toBe(true);
      await link.click();
      await expect.poll(() => row(page, 'me').count()).toBe(1);
      expect(
        requests.filter((r) => r.url.endsWith('/api/buckets')),
      ).toHaveLength(1);
    } finally {
      await closeBrowserPage(page, context);
    }
  },
);
it('E16: a cold Buckets screen makes exactly one list request', async () => {
  const { page, context, requests } = await bucketPage(browser, app.origin);
  try {
    await expect.poll(() => row(page, 'me').count()).toBe(1);
    expect(requests.filter((r) => r.url.endsWith('/api/buckets'))).toHaveLength(
      1,
    );
  } finally {
    await closeBrowserPage(page, context);
  }
});

it('the outline expands, collapses, previews placement, and exposes reserved/child delete reasons', async () => {
  const { page, context } = await bucketPage(browser, app.origin);
  try {
    await page.getByRole('button', { name: 'Collapse all' }).waitFor();
    expect(await row(page, 'work/taecontrol/nook').isVisible()).toBe(true);
    expect(await row(page, 'me').innerText()).toContain('reserved');
    await page.getByRole('button', { name: 'Collapse all' }).click();
    expect(await row(page, 'work/taecontrol/nook').isVisible()).toBe(false);
    await page.getByRole('button', { name: 'Expand all' }).click();
    expect(await row(page, 'work/taecontrol/nook').isVisible()).toBe(true);
    await page
      .getByRole('button', { name: 'Collapse work', exact: true })
      .click();
    expect(await row(page, 'work/taecontrol/nook').isVisible()).toBe(false);
    await page.keyboard.press('/');
    const field = page.getByRole('textbox', { name: 'New bucket path' });
    expect(
      await field.evaluate((element) => element === document.activeElement),
    ).toBe(true);
    await field.fill('work/taecontrol/new');
    expect(await row(page, 'work/taecontrol/new').isVisible()).toBe(true);
    await field.press('Escape');
    expect(await field.inputValue()).toBe('');
    for (const [path, reason] of [
      ['me', 'me is reserved: it always exists and every machine can read it.'],
      ['work', 'Delete its child buckets first.'],
    ]) {
      await page
        .getByRole('button', { name: `Actions for ${path}`, exact: true })
        .click();
      expect(
        await page
          .getByRole('menuitem', { name: 'Delete bucket…' })
          .isDisabled(),
      ).toBe(true);
      expect(await page.getByRole('menu').innerText()).toContain(reason);
      expect(await page.getByRole('menu').innerText()).toContain(
        'Created Sep 12, 2026',
      );
      await page.keyboard.press('Escape');
    }
    await page
      .getByRole('button', { name: 'Actions for work', exact: true })
      .click();
    await page.getByRole('menuitem', { name: 'Create inside' }).click();
    expect(await field.inputValue()).toBe('work/');
    await field.fill('Work/Acme');
    await page
      .getByRole('button', { name: 'work/acme', exact: true })
      .click();
    expect(await field.inputValue()).toBe('work/acme');
    expect(
      await page.getByRole('list', { name: 'Buckets to create' }).innerText(),
    ).toBe('work/acme');
  } finally {
    await closeBrowserPage(page, context);
  }
});

it('the deepest accepted bucket disables Create inside and explains the limit', async () => {
  const { page, context } = await bucketPage(browser, app.origin, {
    buckets: deepBuckets,
  });
  try {
    await page
      .getByRole('button', {
        name: 'Actions for work/taecontrol/clients/municipal-water-authority-ops-mx/infrastructure/terraform-state-backups',
        exact: true,
      })
      .click();
    expect(
      await page.getByRole('menuitem', { name: 'Create inside' }).isDisabled(),
    ).toBe(true);
    expect(await page.getByRole('menu').innerText()).toContain(
      'A bucket path can have at most 6 levels.',
    );
  } finally {
    await closeBrowserPage(page, context);
  }
});

it.each(['POST', 'DELETE'])(
  'E15/E16: a %s remains exclusive across remounts and its one recovery GET',
  async (method) => {
    const { page, context, requests } = await bucketPage(browser, app.origin);
    const path = method === 'POST' ? 'work/a' : 'personal/health';
    const post = deferred();
    const refresh = deferred();
    try {
      await row(page, 'work').waitFor();
      await page.clock.install({ time: new Date() });
      await page.route('**/api/buckets**', async (route) => {
        if (route.request().method() !== 'GET') {
          await post.promise;
          return route.fulfill({
            status: 503,
            json: { _tag: 'ServiceUnavailable' },
          });
        }
        await refresh.promise;
        return route.fulfill({ json: { buckets: typicalBuckets } });
      });
      const field = page.getByRole('textbox', { name: 'New bucket path' });
      if (method === 'POST') {
        await field.fill(path);
        await field.press('Enter');
      } else {
        await page
          .getByRole('button', { name: `Actions for ${path}`, exact: true })
          .click();
        await page.getByRole('menuitem', { name: 'Delete bucket…' }).click();
        await page
          .getByRole('button', { name: 'Delete bucket', exact: true })
          .click();
      }
      await expect
        .poll(() => row(page, path).count())
        .toBe(method === 'POST' ? 1 : 0);
      expect(await field.isDisabled()).toBe(true);
      expect(
        await page
          .getByRole('button', { name: 'Create', exact: true })
          .isDisabled(),
      ).toBe(true);
      await page
        .getByRole('button', {
          name: 'Actions for work/taecontrol/nook',
          exact: true,
        })
        .click();
      expect(
        await page
          .getByRole('menuitem', { name: 'Delete bucket…' })
          .isDisabled(),
      ).toBe(true);
      expect(
        await page
          .getByRole('menuitem', { name: 'Create inside' })
          .isDisabled(),
      ).toBe(true);
      await page.keyboard.press('Escape');
      await page
        .getByRole('navigation', { name: 'breadcrumb' })
        .getByRole('link', { name: 'Nook', exact: true })
        .click();
      await page.clock.fastForward(31_000);
      await page.getByRole('link', { name: 'Buckets', exact: true }).hover();
      await page.getByRole('link', { name: 'Buckets', exact: true }).click();
      await expect
        .poll(() => row(page, path).count())
        .toBe(method === 'POST' ? 1 : 0);
      expect(await field.isDisabled()).toBe(true);
      expect(
        requests.filter(
          (r) => r.method === 'GET' && r.url.endsWith('/api/buckets'),
        ),
      ).toHaveLength(1);
      post.resolve();
      await expect
        .poll(
          () =>
            requests.filter(
              (r) => r.method === 'GET' && r.url.endsWith('/api/buckets'),
            ).length,
        )
        .toBe(2);
      await expect
        .poll(() => row(page, path).count())
        .toBe(method === 'POST' ? 0 : 1);
      expect(await field.isDisabled()).toBe(true);
      refresh.resolve();
      await expect
        .poll(() => page.getByRole('alert').innerText())
        .toContain(
          `Couldn't ${method === 'POST' ? 'create' : 'delete'} ${path}`,
        );
      expect(await field.inputValue()).toBe(method === 'POST' ? path : '');
      expect(await field.isDisabled()).toBe(false);
      if (method === 'POST')
        expect(await row(page, path).innerText()).toContain('new');
      expect(requests.filter((r) => r.method === 'POST')).toHaveLength(
        method === 'POST' ? 1 : 0,
      );
      expect(requests.filter((r) => r.method === 'DELETE')).toHaveLength(
        method === 'DELETE' ? 1 : 0,
      );
      expect(
        requests.filter(
          (r) => r.method === 'GET' && r.url.endsWith('/api/buckets'),
        ),
      ).toHaveLength(2);
    } finally {
      post.resolve();
      refresh.resolve();
      await closeBrowserPage(page, context);
    }
  },
);

it('E15: a failed background refresh preserves the rolled-back outline and offers retry', async () => {
  const { page, context } = await bucketPage(browser, app.origin);
  try {
    await row(page, 'work').waitFor();
    await page.route('**/api/buckets', (route) =>
      route.fulfill({ status: 503, json: { _tag: 'ServiceUnavailable' } }),
    );
    const field = page.getByRole('textbox', { name: 'New bucket path' });
    await field.fill('work/acme');
    await field.press('Enter');
    await expect.poll(() => field.inputValue()).toBe('work/acme');
    for (const path of ['me', 'work', 'work/taecontrol/nook'])
      expect(await row(page, path).isVisible()).toBe(true);
    expect(
      await page
        .getByRole('button', { name: 'Create', exact: true })
        .isDisabled(),
    ).toBe(false);
    expect(
      await page.locator('#bucket-path-feedback').innerText(),
    ).not.toContain('Waiting');
    await page.getByRole('button', { name: 'Try again' }).waitFor();
    await page.route('**/api/buckets', (route) =>
      route.fulfill({ json: { buckets: typicalBuckets } }),
    );
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect
      .poll(() => page.getByRole('button', { name: 'Try again' }).count())
      .toBe(0);
    expect(await row(page, 'work/taecontrol/nook').isVisible()).toBe(true);
  } finally {
    await closeBrowserPage(page, context);
  }
});

it.each(['POST', 'DELETE'])(
  'an optimistic %s cancels a stale preload already in flight',
  async (method) => {
    const { page, context, requests } = await bucketPage(browser, app.origin);
    const read = deferred();
    const post = deferred();
    const readFinished = deferred();
    const abortedReads: string[] = [];
    try {
      await row(page, 'work').waitFor();
      await page.clock.install({ time: new Date() });
      await page
        .getByRole('navigation', { name: 'breadcrumb' })
        .getByRole('link', { name: 'Nook', exact: true })
        .click();
      await page.clock.fastForward(31_000);
      const finished = (request: import('playwright').Request) => {
        if (
          request.method() === 'GET' &&
          request.url().endsWith('/api/buckets')
        )
          readFinished.resolve();
      };
      page.on('requestfinished', finished);
      page.on('requestfailed', (request) => {
        if (
          request.method() === 'GET' &&
          request.url().endsWith('/api/buckets')
        )
          abortedReads.push(request.failure()?.errorText ?? '');
        finished(request);
      });
      await page.route('**/api/buckets**', async (route) => {
        await (route.request().method() === 'GET'
          ? read.promise
          : post.promise);
        return route
          .fulfill(
            route.request().method() === 'DELETE'
              ? { status: 204 }
              : {
                  json:
                    route.request().method() === 'GET'
                      ? { buckets: typicalBuckets }
                      : {
                          path: 'work/new',
                          created: true,
                          createdAncestors: [],
                        },
                },
          )
          .catch(() => {});
      });
      await page.getByRole('link', { name: 'Buckets', exact: true }).hover();
      await expect
        .poll(
          () =>
            requests.filter(
              (r) => r.method === 'GET' && r.url.endsWith('/api/buckets'),
            ).length,
        )
        .toBe(2);
      await page.getByRole('link', { name: 'Buckets', exact: true }).click();
      const field = page.getByRole('textbox', { name: 'New bucket path' });
      if (method === 'POST') {
        await field.fill('work/new');
        await field.press('Enter');
        await expect.poll(() => row(page, 'work/new').innerText()).toBe('new');
      } else {
        await page
          .getByRole('button', {
            name: 'Actions for work/taecontrol/nook',
            exact: true,
          })
          .click();
        await page.getByRole('menuitem', { name: 'Delete bucket…' }).click();
        await page
          .getByRole('button', { name: 'Delete bucket', exact: true })
          .click();
        await expect
          .poll(() => row(page, 'work/taecontrol/nook').count())
          .toBe(0);
      }
      await expect.poll(() => abortedReads).toEqual(['net::ERR_ABORTED']);
      read.resolve();
      await readFinished.promise;
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await expect
        .poll(() => page.getByRole('button', { name: 'Try again' }).count())
        .toBe(0);
      if (method === 'POST')
        expect(await row(page, 'work/new').innerText()).toBe('new');
      else expect(await row(page, 'work/taecontrol/nook').count()).toBe(0);
      expect(
        await page
          .getByRole('button', { name: 'Actions for work/new', exact: true })
          .count(),
      ).toBe(0);
    } finally {
      read.resolve();
      post.resolve();
      await closeBrowserPage(page, context);
    }
  },
);

it.each([
  [
    'work/from-another-machine',
    'work/from-another-machine',
    false,
    [],
    'work/from-another-machine already exists. Nothing changed.',
  ],
  [
    'clients/acme/website',
    'clients',
    true,
    ['clients/acme'],
    'Created clients/acme/website with clients/acme.',
  ],
])(
  'E15/E16: final feedback for %s uses the real server result after an external create',
  async (path, outsidePath, created, ancestors, feedback) => {
    await withRealBuckets(async (page, local, requests) => {
      const field = page.getByRole('textbox', { name: 'New bucket path' });
      await field.fill(path);
      expect(
        await page.getByRole('list', { name: 'Buckets to create' }).innerText(),
      ).toContain(path);
      const outside = await fetch(`${local.origin}/api/buckets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: outsidePath }),
      });
      expect(outside.status).toBe(200);
      const response = page.waitForResponse(
        (response) => response.request().method() === 'POST',
      );
      await field.press('Enter');
      expect(await (await response).json()).toEqual({
        path,
        created,
        createdAncestors: ancestors,
      });
      await expect.poll(() => field.isEnabled()).toBe(true);
      await expect
        .poll(() => page.locator('#bucket-path-feedback').innerText())
        .toBe(feedback);
      expect(
        await page
          .getByRole('button', { name: `Actions for ${path}`, exact: true })
          .count(),
      ).toBe(1);
      expect(await page.getByLabel('Saving', { exact: true }).count()).toBe(0);
      expect(
        requests.filter(
          (request) =>
            request.method === 'GET' && request.url.endsWith('/api/buckets'),
        ),
      ).toHaveLength(2);
    });
  },
);

it.each([false, true])(
  'E15/E16: the latest real failure restores its path and clears optimistic success (unmounted: %s)',
  async (unmounted) => {
    await withRealBuckets(async (page, local, requests) => {
      const field = page.getByRole('textbox', { name: 'New bucket path' });
      await field.fill('work/first');
      const first = page.waitForResponse(
        (response) => response.request().method() === 'POST',
      );
      await field.press('Enter');
      expect((await first).status()).toBe(200);
      await expect.poll(() => field.isEnabled()).toBe(true);
      expect(
        await page
          .getByRole('button', { name: 'Actions for work/first', exact: true })
          .count(),
      ).toBe(1);
      expect(await page.getByLabel('Saving', { exact: true }).count()).toBe(0);
      const db = await local.mf.getD1Database('DB');
      await db
        .prepare(
          "CREATE TRIGGER second_failure BEFORE INSERT ON buckets WHEN NEW.path='work/second' BEGIN SELECT RAISE(ABORT,'synthetic private D1 failure'); END",
        )
        .run();
      const secondWrite = deferred();
      await page.route('**/api/buckets', async (route) => {
        if (route.request().method() === 'POST') await secondWrite.promise;
        await route.continue();
      });
      try {
        await field.fill('work/second');
        const second = page.waitForResponse(
          (response) => response.request().method() === 'POST',
        );
        await field.press('Enter');
        await page.getByLabel('Saving', { exact: true }).waitFor();
        if (unmounted)
          await page
            .getByRole('navigation', { name: 'breadcrumb' })
            .getByRole('link', { name: 'Nook', exact: true })
            .click();
        secondWrite.resolve();
        expect((await second).status()).toBe(503);
        if (unmounted)
          await page
            .getByRole('link', { name: 'Buckets', exact: true })
            .click();
        await expect.poll(() => field.isEnabled()).toBe(true);
        await expect
          .poll(() => page.getByRole('alert').innerText())
          .toContain("Couldn't create work/second");
        expect(await field.inputValue()).toBe('work/second');
        expect(await row(page, 'work/second').innerText()).toContain('new');
        expect(
          await page
            .getByRole('button', {
              name: 'Actions for work/second',
              exact: true,
            })
            .count(),
        ).toBe(0);
        expect(
          await db
            .prepare("SELECT path FROM buckets WHERE path='work/second'")
            .all(),
        ).toMatchObject({ results: [] });
        await field.press('Escape');
        await expect
          .poll(() => page.locator('#bucket-path-feedback').innerText())
          .toBe(
            'Type a path like work/acme. Missing parent buckets are created with it.',
          );
        expect(
          requests.filter((request) => request.method === 'POST'),
        ).toHaveLength(2);
        expect(
          requests.filter(
            (request) =>
              request.method === 'GET' && request.url.endsWith('/api/buckets'),
          ),
        ).toHaveLength(3);
      } finally {
        secondWrite.resolve();
      }
    });
  },
);

it('Cancel returns keyboard focus to the bucket row action', async () => {
  const { page, context } = await bucketPage(browser, app.origin);
  try {
    const actions = page.getByRole('button', {
      name: 'Actions for work/taecontrol/nook',
      exact: true,
    });
    await actions.click();
    await page.getByRole('menuitem', { name: 'Delete bucket…' }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect.poll(() => page.getByRole('alertdialog').count()).toBe(0);
    await expect
      .poll(() =>
        actions.evaluate((button) => button === document.activeElement),
      )
      .toBe(true);
  } finally {
    await closeBrowserPage(page, context);
  }
});
it('a load failure offers a real retry and never enables create without an outline', async () => {
  const { page, context } = await bucketPage(browser, app.origin, {
    loadStatus: 503,
  });
  try {
    await page.getByRole('button', { name: 'Try again' }).waitFor();
    expect(
      await page
        .getByRole('button', { name: 'Create', exact: true })
        .isDisabled(),
    ).toBe(true);
    await page.route('**/api/buckets', (route) =>
      route.fulfill({
        json: {
          buckets: [{ path: 'me', createdAt: '2026-10-04T00:00:00.000Z' }],
        },
      }),
    );
    await page.getByRole('button', { name: 'Try again' }).click();
    await row(page, 'me').waitFor();
    expect(
      await page
        .getByRole('button', { name: 'Create', exact: true })
        .isDisabled(),
    ).toBe(false);
  } finally {
    await closeBrowserPage(page, context);
  }
});
it('the derived browser client deletes a nested path through the real Worker and D1', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const created = await fetch(`${app.origin}/api/buckets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'derived/nested' }),
    });
    expect(created.status).toBe(200);
    await page.goto(`${app.origin}/buckets`);
    await page
      .getByRole('button', { name: 'Actions for derived/nested', exact: true })
      .click();
    await page.getByRole('menuitem', { name: 'Delete bucket…' }).click();
    const deleted = page.waitForResponse(
      (response) => response.request().method() === 'DELETE',
    );
    await page
      .getByRole('button', { name: 'Delete bucket', exact: true })
      .click();
    expect((await deleted).status()).toBe(204);
    await expect
      .poll(async () =>
        (
          (await (await fetch(`${app.origin}/api/buckets`)).json()) as {
            buckets: { path: string }[];
          }
        ).buckets.map((bucket) => bucket.path),
      )
      .toEqual(['derived', 'me']);
  } finally {
    await closeBrowserPage(page, context);
  }
});
