import { once } from 'node:events';
import {
  Agent,
  createServer,
  type IncomingMessage,
  request,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { loadTimeBudgets } from './load-time.ts';

async function waitUntil(time: number, signal: AbortSignal) {
  while (performance.now() < time)
    await delay(Math.ceil(time - performance.now()), undefined, { signal });
  signal.throwIfAborted();
}

// All streams in one direction reserve time on the same clock. Small chunks
// bound buffering and let concurrent connections share the link without bursts.
class Bandwidth {
  private available = 0;
  private readonly bytesPerSecond: number;
  constructor(bytesPerSecond: number) {
    this.bytesPerSecond = bytesPerSecond;
  }

  async *transfer(source: AsyncIterable<Buffer>, signal: AbortSignal) {
    for await (const chunk of source) {
      for (let offset = 0; offset < chunk.length; offset += 16_384) {
        const part = chunk.subarray(offset, offset + 16_384);
        this.available =
          Math.max(performance.now(), this.available) +
          (part.length * 1000) / this.bytesPerSecond;
        await waitUntil(this.available, signal);
        yield part;
      }
    }
  }
}

export async function startPhoneNetwork() {
  const network = loadTimeBudgets.network;
  const download = new Bandwidth(network.downloadThroughput);
  const upload = new Bandwidth(network.uploadThroughput);
  const controller = new AbortController();
  const agent = new Agent({ keepAlive: true });
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    if (sockets.has(socket)) return;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  async function forward(incoming: IncomingMessage, outgoing: ServerResponse) {
    const cancelled = new AbortController();
    outgoing.once('close', () => cancelled.abort());
    const signal = AbortSignal.any([controller.signal, cancelled.signal]);
    const target = new URL(
      incoming.url ?? '',
      `http://${incoming.headers.host}`,
    );
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1')
      throw new Error('Phone measurements require a loopback HTTP origin.');
    // DevTools' profile adds latency per request, not once per TCP connection
    // or once in each direction. Delay forwarding even on a reused socket.
    await waitUntil(performance.now() + network.latency, signal);
    const upstream = request(target, {
      method: incoming.method,
      headers: incoming.headers,
      agent,
    });
    upstream.on('socket', track);
    const response = once(upstream, 'response', { signal });
    const sent = pipeline(
      incoming,
      (source) => upload.transfer(source, signal),
      upstream,
      { signal },
    );
    // Observe both promises immediately: an upload failure can precede headers.
    const [[received]] = await Promise.all([response, sent]);
    const body = received as IncomingMessage;
    outgoing.writeHead(body.statusCode ?? 502, body.headers);
    await pipeline(
      body,
      (source) => download.transfer(source, signal),
      outgoing,
      { signal },
    );
  }
  const server = createServer((incoming, outgoing) => {
    void forward(incoming, outgoing).catch(() => {
      incoming.destroy();
      outgoing.destroy();
    });
  });
  server.on('connection', track);
  // Playwright's route.fetch uses CONNECT even for HTTP. Parse the tunneled
  // requests through this same server so they pay latency and share bandwidth.
  server.on('connect', (request, socket, head) => {
    if (!/^127\.0\.0\.1:\d+$/.test(request.url ?? '')) return socket.destroy();
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) socket.unshift(head);
    server.emit('connection', socket);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    proxy: {
      server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      // Chromium otherwise bypasses proxies for the runtime's loopback origin.
      bypass: '<-loopback>',
    },
    close() {
      controller.abort();
      server.close();
      agent.destroy();
      for (const socket of sockets) socket.destroy();
    },
  };
}
