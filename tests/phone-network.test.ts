import { once } from 'node:events';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadTimeBudgets } from '../scripts/lib/load-time.ts';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { phonePage } from '../scripts/load-time-browser.ts';

const downloadBytes = 450_000;
const uploadBytes = 150_000;
let cacheReads = 0;
async function respond(request: IncomingMessage, response: ServerResponse) {
  let bytes = 0;
  for await (const chunk of request) bytes += chunk.length;
  if (request.url === '/download') {
    response.end(Buffer.alloc(downloadBytes));
    return;
  }
  if (request.url === '/cache') {
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    response.end(String(++cacheReads));
    return;
  }
  if (request.url === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Phone network</title>');
    return;
  }
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ bytes, ...request.headers }));
}
const server = createServer((request, response) => {
  void respond(request, response).catch(() => response.destroy());
});
let origin: string;
let browser: Browser;
let closeBrowser: (() => Promise<void>) | undefined;
beforeAll(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

it('#101: every request pays at least 85 ms, including requests on reused connections', async () => {
  const { context, page } = await phonePage(browser, 'memory');
  try {
    await page.goto(origin);
    const latencies = await page.evaluate(async () => {
      const elapsed: number[] = [];
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        await (await fetch(`/ping?${i}`)).text();
        elapsed.push(performance.now() - start);
      }
      return elapsed;
    });
    expect(latencies).toHaveLength(3);
    for (const latency of latencies)
      expect(latency).toBeGreaterThanOrEqual(loadTimeBudgets.network.latency);
  } finally {
    await context.close();
  }
});

it.each(['download', 'upload'] as const)(
  '#101: concurrent %ss share the page throughput limit',
  async (direction) => {
    const { context, page } = await phonePage(browser, 'memory');
    try {
      await page.goto(origin);
      const result = await page.evaluate(
        async ({ direction, uploadBytes }) => {
          const started = performance.now();
          const sizes = await Promise.all(
            Array.from({ length: 3 }, async () => {
              const response = await fetch(`/${direction}`, {
                method: direction === 'upload' ? 'POST' : 'GET',
                body:
                  direction === 'upload' ? 'x'.repeat(uploadBytes) : undefined,
              });
              return direction === 'upload'
                ? (await response.json()).bytes
                : (await response.arrayBuffer()).byteLength;
            }),
          );
          return { elapsed: performance.now() - started, sizes };
        },
        { direction, uploadBytes },
      );
      const bytes = direction === 'download' ? downloadBytes : uploadBytes;
      const rate = loadTimeBudgets.network[`${direction}Throughput`];
      expect(result.sizes).toEqual([bytes, bytes, bytes]);
      expect(result.elapsed).toBeGreaterThanOrEqual((3 * bytes * 1000) / rate);
    } finally {
      await context.close();
    }
  },
);

it('#101: cacheable responses still reach the server on every read', async () => {
  const { context, page } = await phonePage(browser, 'memory');
  try {
    await page.goto(origin);
    const before = cacheReads;
    const reads = await page.evaluate(async () => {
      const first = await (await fetch('/cache')).text();
      const second = await (await fetch('/cache')).text();
      return [first, second];
    });
    expect(reads).toEqual([String(before + 1), String(before + 2)]);
    expect(cacheReads).toBe(before + 2);
  } finally {
    await context.close();
  }
});

it('#101: the app keeps its origin, cookies and Origin/Host headers', async () => {
  const { context, page } = await phonePage(browser, 'memory');
  try {
    await context.addCookies([
      { name: 'owner', value: 'synthetic', url: origin },
    ]);
    await page.goto(origin);
    expect(new URL(page.url()).origin).toBe(origin);
    const headers = await page.evaluate(async () =>
      (await fetch('/headers', { method: 'POST', body: 'test' })).json(),
    );
    expect(headers).toMatchObject({
      bytes: 4,
      host: new URL(origin).host,
      origin,
      cookie: 'owner=synthetic',
    });
  } finally {
    await context.close();
  }
});
