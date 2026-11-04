import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { measureInitialJs } from '../scripts/lib/load-time.ts';
import { testBuild } from './support/runtime.ts';

it('the first load stays in four chunks and approval pages stay lazy', async () => {
  const assets = resolve(testBuild, 'assets');
  const initial = await measureInitialJs(assets);
  expect(initial.files).toHaveLength(4);
  const scripts = await Promise.all(
    initial.files.map(({ source }) =>
      readFile(resolve(assets, source.slice(1)), 'utf8'),
    ),
  );
  for (const source of scripts) {
    expect(source).not.toContain('Approve this run?');
    expect(source).not.toContain('Nothing waiting for you');
  }
});
