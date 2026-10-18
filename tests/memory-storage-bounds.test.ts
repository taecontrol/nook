import { expect, it } from 'vitest';
import { memories } from './fixtures/memory-history.ts';
import { memoryRuntime } from './support/memory.ts';
import { seedHistory } from './support/memory-history.ts';

it('owner history keeps its 26-version page and next boundary', async () => {
  const app = await memoryRuntime();
  try {
    const fixture = memories[1];
    await seedHistory(app, [
      {
        ...fixture,
        versions: Array.from({ length: 27 }, (_, index) => ({
          ...fixture.versions[0],
          content: `Synthetic history version ${index + 1}.`,
          minutesAgo: 27 - index,
        })),
      },
    ]);
    const first = await fetch(
      `${app.origin}/api/memories/${fixture.id}/versions`,
    );
    expect(first.status).toBe(200);
    const page = await first.json();
    expect(
      page.versions.map((version: { version: number }) => version.version),
    ).toEqual(Array.from({ length: 26 }, (_, index) => 27 - index));
    expect(page.next).toBe(2);
    const next = await fetch(
      `${app.origin}/api/memories/${fixture.id}/versions?before=2`,
    );
    expect(next.status).toBe(200);
    expect(await next.json()).toMatchObject({
      versions: [{ version: 1 }],
      next: null,
    });
  } finally {
    await app.close();
  }
});
