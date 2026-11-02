import { once } from 'node:events';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { loadTimeBudgets } from '../scripts/lib/load-time.ts';
import * as phoneNetwork from '../scripts/lib/phone-network.ts';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { phonePage } from '../scripts/load-time-browser.ts';

const downloadBytes = 450_000;
const uploadBytes = 150_000;
let cacheReads = 0;
let pendingClosed = false;
let heldReceived = false;
let heldClosed = false;
async function respond(request: IncomingMessage, response: ServerResponse) {
  let bytes = 0;
  for await (const chunk of request) bytes += chunk.length;
  if (request.url === '/held') {
    heldClosed = false;
    response.once('close', () => {
      heldClosed = true;
    });
    heldReceived = true;
    return;
  }
  if (request.url === '/pending') {
    pendingClosed = false;
    response.once('close', () => {
      pendingClosed = true;
    });
    response.write('pending');
    return;
  }
  if (request.url?.startsWith('/download')) {
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

it.each([
  ['download', 'browser'],
  ['upload', 'browser'],
  ['download', 'route.fetch'],
  ['upload', 'route.fetch'],
] as const)(
  '#101: concurrent %ss via %s share the page throughput limit',
  async (direction, transport) => {
    const { context, page } = await phonePage(browser, 'memory');
    try {
      await page.goto(origin);
      if (transport === 'route.fetch')
        await page.route(`**/${direction}?*`, async (route) => {
          await route.fulfill({ response: await route.fetch() });
        });
      const result = await page.evaluate(
        async ({ direction, uploadBytes }) => {
          const started = performance.now();
          const sizes = await Promise.all(
            Array.from({ length: 3 }, async (_, i) => {
              const response = await fetch(`/${direction}?${i}`, {
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

it('#101: a request aborted before its response headers releases its upstream request', async () => {
  const { context, page } = await phonePage(browser, 'memory');
  try {
    await page.goto(origin);
    heldReceived = false;
    const held = await page.evaluateHandle(() => {
      const controller = new AbortController();
      void fetch('/held', { signal: controller.signal }).catch(() => {});
      return controller;
    });
    await expect.poll(() => heldReceived).toBe(true);
    await held.evaluate((controller) => controller.abort());
    await expect.poll(() => heldClosed).toBe(true);
  } finally {
    await context.close();
  }
});

async function canConnect(address: string) {
  const url = new URL(address);
  return new Promise<boolean>((resolve) => {
    const socket = connect(Number(url.port), url.hostname);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

it.each(['context', 'browser'] as const)(
  '#101: closing the %s releases the proxy listener and unfinished upstream sockets',
  async (scope) => {
    const owned = await launchTestBrowser();
    const started = vi.spyOn(phoneNetwork, 'startPhoneNetwork');
    let network:
      | Awaited<ReturnType<typeof phoneNetwork.startPhoneNetwork>>
      | undefined;
    try {
      const { context, page } = await phonePage(owned.browser, 'memory');
      network = (await started.mock.results[0].value) as Awaited<
        ReturnType<typeof phoneNetwork.startPhoneNetwork>
      >;
      started.mockRestore();
      await page.goto(origin);
      expect(await canConnect(network.proxy.server)).toBe(true);
      const pending = page.waitForResponse(`${origin}/pending`);
      await page.evaluate(() => {
        void fetch('/pending')
          .then((r) => r.text())
          .catch(() => {});
      });
      await pending;
      if (scope === 'browser') await owned.close();
      else await context.close();
      expect(await canConnect(network.proxy.server)).toBe(false);
      await expect.poll(() => pendingClosed).toBe(true);
    } finally {
      started.mockRestore();
      network?.close();
      await owned.close();
    }
  },
);

it('#101: failed context setup closes the proxy listener', async () => {
  const owned = await launchTestBrowser();
  await owned.close();
  const started = vi.spyOn(phoneNetwork, 'startPhoneNetwork');
  let network:
    | Awaited<ReturnType<typeof phoneNetwork.startPhoneNetwork>>
    | undefined;
  try {
    await expect(phonePage(owned.browser, 'memory')).rejects.toThrow();
    network = (await started.mock.results[0].value) as Awaited<
      ReturnType<typeof phoneNetwork.startPhoneNetwork>
    >;
    expect(await canConnect(network.proxy.server)).toBe(false);
  } finally {
    started.mockRestore();
    network?.close();
  }
});
