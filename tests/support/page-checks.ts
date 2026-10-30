import type { Locator, Page } from 'playwright';
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

// A dialog or sheet, once its open animation settles, lies inside the viewport
// and no content inside it reaches past its sides. Fixed layers never widen
// the document, so expectNoOverflow cannot see them.
export async function expectWithinViewport(element: Locator) {
  const layout = await element.evaluate(async (node) => {
    await Promise.all(
      node
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    );
    const box = node.getBoundingClientRect();
    return {
      left: box.left,
      top: box.top,
      right: innerWidth - box.right,
      bottom: innerHeight - box.bottom,
      outside: Array.from(node.querySelectorAll('*'))
        .filter((child) => {
          const inner = child.getBoundingClientRect();
          return (
            inner.width > 0 &&
            (inner.left < box.left - 1 || inner.right > box.right + 1)
          );
        })
        .map((child) => child.textContent?.slice(0, 40) || child.tagName),
    };
  });
  expect(layout.outside, 'content past the sides').toEqual([]);
  for (const edge of ['left', 'top', 'right', 'bottom'] as const)
    expect(
      layout[edge],
      `${edge} edge inside the viewport`,
    ).toBeGreaterThanOrEqual(0);
}
