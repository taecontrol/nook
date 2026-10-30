import type { QueryClient } from '@tanstack/react-query';
import type { Page } from 'playwright';

export function vaultCache(page: Page) {
  return page.evaluateHandle(() => {
    const root = document.querySelector('#root > *');
    const key = Object.keys(root ?? {}).find((key) =>
      key.startsWith('__reactFiber$'),
    );
    type Fiber = { return?: Fiber; memoizedProps?: { client?: QueryClient } };
    let fiber = key
      ? (root as unknown as Record<string, Fiber>)[key]
      : undefined;
    while (fiber) {
      if (fiber.memoizedProps?.client) return fiber.memoizedProps.client;
      fiber = fiber.return;
    }
    throw new Error('QueryClient provider missing.');
  });
}
