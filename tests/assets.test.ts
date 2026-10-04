import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runtime, type TestRuntime } from './support/runtime.ts';

let app: TestRuntime;
let scripts: string[];
beforeAll(async () => {
  app = await runtime();
  const response = await fetch(app.origin);
  const html = await response.text();
  scripts = [...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+\.js)"/g)].map(
    (match) => match[1],
  );
});
afterAll(async () => {
  await app?.close();
});

it('E6: serves documents, hashed assets and deep SPA routes through the asset layer', async () => {
  const home = await fetch(app.origin);
  expect(home.status).toBe(200);
  expect(home.headers.get('Content-Type')).toContain('text/html');
  const html = await home.text();
  expect(html).toContain('<div id="root">');
  expect(scripts.length).toBeGreaterThan(0);
  for (const source of scripts) {
    expect(source).toMatch(/\/assets\/[^/]+-[a-zA-Z0-9_-]+\.js$/);
    const asset = await fetch(`${app.origin}${source}`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('Content-Type')).toMatch(/javascript/);
  }
  const deep = await fetch(`${app.origin}/buckets/work`);
  expect(deep.status).toBe(200);
  expect(await deep.text()).toBe(html);
  for (const path of ['/api/whoami', '/mcp']) {
    expect((await fetch(`${app.origin}${path}`)).status).toBe(401);
  }
});

it('E7: caches hashed assets immutably for one year and never caches documents that way', async () => {
  expect(scripts.length).toBeGreaterThan(0);
  for (const source of scripts) {
    const response = await fetch(`${app.origin}${source}`);
    expect(response.headers.get('Cache-Control')).toBe(
      'public, max-age=31536000, immutable',
    );
  }
  for (const path of ['/', '/index.html', '/buckets/work']) {
    const response = await fetch(`${app.origin}${path}`);
    expect(response.headers.get('Cache-Control') ?? '').not.toMatch(
      /immutable|31536000/,
    );
  }
});

it('E8: changing the committed configuration routing changes the local runtime', async () => {
  const directory = await mkdtemp(resolve('.local', 'routing-'));
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  config.assets.run_worker_first = [
    ...config.assets.run_worker_first,
    '/buckets/*',
  ];
  const configPath = resolve(directory, 'wrangler.json');
  await writeFile(configPath, JSON.stringify(config));
  const changed = await runtime({ configPath });
  try {
    const response = await fetch(`${changed.origin}/buckets/work`);
    expect(response.status).toBe(401);
    expect(response.headers.get('Content-Type')).toMatch(/application\/json/);
    expect((await fetch(changed.origin)).status).toBe(200);
  } finally {
    await changed.close();
    await rm(directory, { recursive: true, force: true });
  }
});
