import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import {
  measureScreen,
  phonePage,
  withPageEvidence,
} from '../scripts/load-time-browser.ts';
import { jsonRequest, ownerRuntime } from './support/authorizations.ts';
import { issueGrant, seedGrantTree } from './support/grants.ts';
import { deferred } from './support/machines.ts';
import { runtime, type TestRuntime } from './support/runtime.ts';

let app: TestRuntime;
let browser: Browser;
let closeBrowser: () => Promise<void>;
beforeAll(async () => {
  app = await ownerRuntime(await runtime());
  await seedGrantTree(app);
  await issueGrant(app, ['work/acme']);
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
  await app?.close();
});

it('E17: the production editor timing measures its rendered checked tree on the 390 px phone', async () => {
  const { context, page } = await phonePage(browser, 'machineAccessNavigation');
  try {
    expect(page.viewportSize()).toEqual({ width: 390, height: 844 });
    const measured = await measureScreen(
      page,
      app.origin,
      '',
      'machineAccessNavigation',
    );
    expect(Number.isFinite(measured)).toBe(true);
    expect(measured).toBeGreaterThanOrEqual(0);
    expect(new URL(page.url()).pathname).toBe('/machines');
    const sheet = page.getByRole('dialog', {
      name: 'Edit access',
      exact: true,
    });
    expect(await sheet.isVisible()).toBe(true);
    expect(
      await sheet
        .getByRole('checkbox', { name: 'work/acme', exact: true })
        .isChecked(),
    ).toBe(true);
    expect(
      await sheet
        .getByRole('checkbox', { name: 'me', exact: true })
        .isVisible(),
    ).toBe(true);
  } finally {
    await context.close();
  }
});

type Condition =
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'absent'
  | 'unchecked'
  | 'preload';
type FrameState = {
  frames: { timestamp: number; entered: number }[];
  clicked: number;
  clickedFrame: number;
  qualified: number;
  checkpoint: number;
  requested?: boolean;
  visible?: boolean;
  style?: HTMLStyleElement;
  element?: Element;
  placeholder?: Comment;
};
type ProbeWindow = typeof window & { rendererProbe: FrameState };

async function installOracle(page: Page, condition: Condition) {
  await page.addInitScript((condition) => {
    const state: FrameState = {
      frames: [],
      clicked: 0,
      clickedFrame: 0,
      qualified: 0,
      checkpoint: 0,
    };
    (window as ProbeWindow).rendererProbe = state;
    const recordFrame = (timestamp: number) => {
      state.frames.push({ timestamp, entered: performance.now() });
      requestAnimationFrame(recordFrame);
    };
    requestAnimationFrame(recordFrame);
    if (condition === 'absent') {
      const observer = new MutationObserver(() => {
        if (!state.clicked || state.element) return;
        const row = document
          .querySelector('[role="checkbox"][aria-label="me"]')
          ?.closest('li');
        if (!row) return;
        state.element = row;
        state.placeholder = document.createComment('review-held-real-row');
        row.replaceWith(state.placeholder);
      });
      observer.observe(document, { childList: true, subtree: true });
    }
    document.addEventListener(
      'click',
      (event) => {
        if (!(event.target instanceof Element)) return;
        if (
          condition === 'unchecked' &&
          event.target.closest('[role="checkbox"][aria-label="All buckets"]')
        ) {
          state.requested = true;
          return;
        }
        if (!event.target.closest('button[aria-label^="Edit access of "]'))
          return;
        state.clicked = performance.now();
        state.clickedFrame = state.frames.length;
        const translations = {
          left: '-2000px, 0',
          right: '2000px, 0',
          top: '0, -2000px',
          bottom: '0, 2000px',
        };
        if (!(condition in translations)) return;
        const instant = document.createElement('style');
        instant.textContent =
          '[role="dialog"] { transition: none !important; }';
        document.head.append(instant);
        const style = document.createElement('style');
        style.textContent = `[role="dialog"] { transform: translate(${translations[condition as keyof typeof translations]}); }`;
        state.style = style;
        document.head.append(style);
      },
      { capture: true },
    );
  }, condition);
}
async function fiveFramesAfterClick(page: Page) {
  await page.waitForFunction(() => {
    const state = (window as ProbeWindow).rendererProbe;
    return state?.clicked && state.frames.length >= state.clickedFrame + 5;
  });
}
async function qualify(page: Page) {
  await page.evaluate(() => {
    const state = (window as ProbeWindow).rendererProbe;
    state.requested = true;
    state.style?.remove();
    if (state.element && state.placeholder?.parentNode)
      state.placeholder.replaceWith(state.element);
  });
}
async function watchQualification(page: Page, requireChecked: boolean) {
  await page.evaluate((requireChecked) => {
    const state = (window as ProbeWindow).rendererProbe;
    const control =
      state.element?.querySelector('[role="checkbox"][aria-label="me"]') ??
      document.querySelector('[role="checkbox"][aria-label="me"]');
    if (!control) throw new Error('The real public me control is required.');
    const ready = (time: number) => {
      if (
        state.requested &&
        state.visible &&
        (!requireChecked || control.getAttribute('aria-checked') === 'true') &&
        !state.qualified
      )
        state.qualified = time;
    };
    new IntersectionObserver(
      (entries) => {
        const entry = entries.find((entry) => entry.target === control);
        if (!entry) return;
        state.visible = entry.isIntersecting && entry.intersectionRatio === 1;
        ready(entry.time);
      },
      { threshold: [1] },
    ).observe(control);
    if (requireChecked)
      new MutationObserver(() => ready(performance.now())).observe(control, {
        attributes: true,
        attributeFilter: ['aria-checked'],
      });
  }, requireChecked);
}
async function assertInterval(page: Page, returned: number) {
  const observed = await page.evaluate(() => {
    const state = (window as ProbeWindow).rendererProbe;
    const native = performance
      .getEntriesByType('measure')
      .filter((entry) => entry.startTime >= state.clicked)
      .at(-1);
    const end = native ? native.startTime + native.duration : 0;
    // Frame timestamps can precede callback execution under main-thread load.
    // Readiness and the native mark use the callback-entry clock instead.
    const qualifiedFrames = state.frames.filter(
      (frame) => frame.entered > state.qualified && frame.entered <= end,
    );
    return {
      clicked: state.clicked,
      qualified: state.qualified,
      firstFrameAfterClick: state.frames.find(
        (frame) => frame.entered > state.clicked,
      )?.entered,
      native: native
        ? { start: native.startTime, duration: native.duration }
        : null,
      qualifiedFrames: new Set(qualifiedFrames.map((frame) => frame.timestamp))
        .size,
    };
  });
  expect(observed.native).not.toBeNull();
  expect(returned).toBe(observed.native?.duration);
  expect(observed.qualified).toBeGreaterThan(0);
  expect(
    (observed.native?.start ?? 0) - observed.clicked,
  ).toBeGreaterThanOrEqual(0);
  expect(observed.native?.start).toBeLessThanOrEqual(
    observed.firstFrameAfterClick ?? 0,
  );
  expect(observed.qualifiedFrames).toBeGreaterThanOrEqual(2);
}

// Runs a step of a test while its measurement is pending. The step fails at
// once when the measurement fails first, with the measurement's own error, and
// otherwise fails with its own error and the page evidence.
async function whileMeasuring<T>(
  page: Page,
  measurement: Promise<unknown>,
  step: () => Promise<T>,
) {
  return Promise.race([
    measurement.then(() => new Promise<never>(() => {})),
    withPageEvidence(page, step),
  ]);
}

it('#100: a measurement that fails before the click fails the test at once with page evidence', async () => {
  const { context, page } = await phonePage(browser, 'machineAccessNavigation');
  const preload = deferred();
  try {
    await page.addInitScript(() => {
      console.error('synthetic console error');
      console.error('synthetic replacement text: $& $$');
      setTimeout(() => {
        throw new Error('synthetic page error');
      });
    });
    await page.route('**/api/buckets', async (route) => {
      await preload.promise;
      await route.abort().catch(() => {});
    });
    const measurement = measureScreen(
      page,
      app.origin,
      '',
      'machineAccessNavigation',
      { preloadTimeout: 1_000 },
    );
    void measurement.catch(() => {});
    const started = performance.now();
    const failure = await whileMeasuring(page, measurement, () =>
      page.getByRole('dialog', { name: 'Edit access', exact: true }).waitFor(),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(failure).toBe(await measurement.catch((error: unknown) => error));
    const message = failure instanceof Error ? failure.message : '';
    expect(message).toContain(
      'Intent preload did not reach 500 ms of network quiet.',
    );
    expect(message).toMatch(
      new RegExp(`GET ${app.origin}/api/buckets, pending for \\d+ ms`),
    );
    expect(message).toContain('document.readyState: complete');
    expect(message).toContain('#root: rendered');
    expect(message).toContain('synthetic console error');
    expect(message).toContain('synthetic page error');
    expect(failure instanceof Error ? failure.stack : '').toContain(
      'synthetic replacement text: $& $$',
    );
  } finally {
    preload.resolve();
    await context.close();
  }
});

it('#100: a wait that times out while the measurement is pending fails with page evidence', async () => {
  const { context, page } = await phonePage(browser, 'machineAccessNavigation');
  const preload = deferred();
  let measurement: Promise<number> | undefined;
  try {
    await page.route('**/api/buckets', async (route) => {
      await preload.promise;
      await route.abort().catch(() => {});
    });
    measurement = measureScreen(
      page,
      app.origin,
      '',
      'machineAccessNavigation',
    );
    void measurement.catch(() => {});
    const failure = await whileMeasuring(page, measurement, async () => {
      await page.waitForRequest('**/api/buckets');
      await page
        .getByRole('dialog', { name: 'Edit access', exact: true })
        .waitFor({ timeout: 1_000 });
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    const message = failure instanceof Error ? failure.message : '';
    expect(message).toContain('locator.waitFor: Timeout 1000ms exceeded.');
    expect(message).toMatch(
      new RegExp(`GET ${app.origin}/api/buckets, pending for \\d+ ms`),
    );
    expect(message).toContain('#root: rendered');
  } finally {
    preload.resolve();
    await context.close();
    await measurement?.catch(() => {});
  }
});

it.each(['left', 'right', 'top', 'bottom', 'absent'] as const)(
  'E17: timing stays pending until the rendered tree enters the viewport: %s',
  async (condition) => {
    const { context, page } = await phonePage(
      browser,
      'machineAccessNavigation',
    );
    let measurement: Promise<number> | undefined;
    try {
      await installOracle(page, condition);
      let settled = false;
      measurement = measureScreen(
        page,
        app.origin,
        '',
        'machineAccessNavigation',
      ).finally(() => {
        settled = true;
      });
      void measurement.catch(() => {});
      await whileMeasuring(page, measurement, async () => {
        await page
          .getByRole('dialog', { name: 'Edit access', exact: true })
          .waitFor();
        await fiveFramesAfterClick(page);
        const me = page.getByRole('checkbox', { name: 'me', exact: true });
        if (condition === 'absent') expect(await me.count()).toBe(0);
        else {
          const box = await me.boundingBox();
          expect(box).not.toBeNull();
          if (condition === 'left')
            expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThan(0);
          if (condition === 'right') expect(box?.x).toBeGreaterThan(390);
          if (condition === 'top')
            expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThan(0);
          if (condition === 'bottom') expect(box?.y).toBeGreaterThan(844);
        }
        expect(settled).toBe(false);
        await watchQualification(page, false);
        await qualify(page);
      });
      await assertInterval(page, await measurement);
    } finally {
      await context.close();
      await measurement?.catch(() => {});
    }
  },
);

it('E17: Edit waits for its real intent preload and a fresh quiet window', async () => {
  const { context, page } = await phonePage(browser, 'machineAccessNavigation');
  let measurement: Promise<number> | undefined;
  let release: (() => void) | undefined;
  try {
    await installOracle(page, 'preload');
    const held = new Promise<void>((done) => {
      release = done;
    });
    let intercepted: () => void = () => {};
    const ready = new Promise<void>((done) => {
      intercepted = done;
    });
    await page.route('**/api/buckets', async (route) => {
      const response = await route.fetch();
      intercepted();
      await held;
      await route.fulfill({ response });
    });
    let settled = false;
    measurement = measureScreen(
      page,
      app.origin,
      '',
      'machineAccessNavigation',
    ).finally(() => {
      settled = true;
    });
    void measurement.catch(() => {});
    await whileMeasuring(page, measurement, async () => {
      await ready;
      await page.evaluate(() => {
        const state = (window as ProbeWindow).rendererProbe;
        state.checkpoint = state.frames.length;
      });
      await page.waitForFunction(() => {
        const state = (window as ProbeWindow).rendererProbe;
        return state.frames.length >= state.checkpoint + 5;
      });
      expect(settled).toBe(false);
      expect(
        await page.evaluate(
          () => (window as ProbeWindow).rendererProbe.clicked,
        ),
      ).toBe(0);
    });
    release?.();
    await measurement;
    const timing = await page.evaluate(() => {
      const preload = performance
        .getEntriesByType('resource')
        .find((entry) => new URL(entry.name).pathname === '/api/buckets');
      if (!(preload instanceof PerformanceResourceTiming))
        throw new Error('The real bucket preload must have native timing.');
      return {
        responseEnd: preload.responseEnd,
        quiet:
          (window as ProbeWindow).rendererProbe.clicked - preload.responseEnd,
      };
    });
    expect(timing.responseEnd).toBeGreaterThan(0);
    expect(timing.quiet).toBeGreaterThanOrEqual(500);
  } finally {
    release?.();
    await context.close();
    await measurement?.catch(() => {});
  }
});

it('E17: timing waits for a checked tree after the approved root is deleted', async () => {
  const missing = await ownerRuntime(await runtime());
  try {
    await seedGrantTree(missing, ['me', 'work', 'work/acme']);
    await issueGrant(missing, ['work/acme']);
    expect(
      (
        await jsonRequest(
          missing,
          '/api/buckets/work%2Facme',
          undefined,
          {},
          'DELETE',
        )
      ).status,
    ).toBe(204);
    const { context, page } = await phonePage(
      browser,
      'machineAccessNavigation',
    );
    let measurement: Promise<number> | undefined;
    try {
      await installOracle(page, 'unchecked');
      let settled = false;
      measurement = measureScreen(
        page,
        missing.origin,
        '',
        'machineAccessNavigation',
      ).finally(() => {
        settled = true;
      });
      void measurement.catch(() => {});
      const sheet = page.getByRole('dialog', {
        name: 'Edit access',
        exact: true,
      });
      await whileMeasuring(page, measurement, async () => {
        await sheet.waitFor();
        await fiveFramesAfterClick(page);
        expect(
          await sheet
            .getByRole('checkbox', { name: 'me', exact: true })
            .isChecked(),
        ).toBe(false);
        expect(
          await sheet
            .getByRole('checkbox', { name: 'work', exact: true })
            .isChecked(),
        ).toBe(false);
        expect(settled).toBe(false);
        await watchQualification(page, true);
        await page.waitForFunction(
          () => (window as ProbeWindow).rendererProbe.visible,
        );
        await sheet
          .getByRole('checkbox', { name: 'All buckets', exact: true })
          .click();
      });
      await assertInterval(page, await measurement);
    } finally {
      await context.close();
      await measurement?.catch(() => {});
    }
  } finally {
    await missing.close();
  }
});
