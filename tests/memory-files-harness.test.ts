import { expect, it } from 'vitest';
import { fileObjects, seedFileMemory } from './support/memory-files.ts';
import { filesRuntime } from './support/memory-files-runtime.ts';

it('the attachment harness reaches the built Worker, local D1/R2, checkpoints and a controlled D1 clock', async () => {
  const app = await filesRuntime({ now: 1_800_000_000_000 });
  try {
    await seedFileMemory(app);
    const read = await fetch(`${app.origin}/api/memories?bucket=work/mamasan`);
    expect(read.status).toBe(200);
    expect((await read.json()).memories).toHaveLength(1);
    expect(app.labels).toContain('/after-batch');
    const probe = await fetch(`${app.origin}/api/__test/files-probe`, {
      method: 'PUT',
    });
    expect(probe.status).toBe(200);
    expect(await probe.json()).toEqual({ now: 1_800_000_000_000 });
    expect(await fileObjects(app)).toHaveLength(1);
    expect(app.labels).toContain('/r2/after-put');
    app.setTime(1_800_000_600_000);
    const next = await fetch(`${app.origin}/api/__test/files-probe`, {
      method: 'DELETE',
    });
    expect(await next.json()).toEqual({ now: 1_800_000_600_000 });
    expect(app.labels).toContain('/r2/before-delete');
    expect(await fileObjects(app)).toEqual([]);
  } finally {
    await app.close();
  }
});
it('the attachment harness can inject a post-put failure while leaving the real object present', async () => {
  const app = await filesRuntime({
    checkpoint: async (label) => label !== '/r2/after-put',
  });
  try {
    const response = await fetch(`${app.origin}/api/__test/files-probe`, {
      method: 'PUT',
    });
    expect(response.status).toBe(500);
    await response.body?.cancel();
    expect(await fileObjects(app)).toHaveLength(1);
  } finally {
    await app.close();
  }
});
