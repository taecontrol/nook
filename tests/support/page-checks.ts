import type { Page } from 'playwright';
import { expect } from 'vitest';

// Nothing on the page scrolls sideways at the current viewport.
export async function expectNoOverflow(page: Page) {
  const layout = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(layout.scroll).toBe(layout.width);
}

// Collects uncaught page errors; call the result to assert there were none.
export function watchPageErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return () => expect(errors).toEqual([]);
}
