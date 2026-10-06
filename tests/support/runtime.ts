import { randomInt } from 'node:crypto';
import { mkdir, readFile, rmdir } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';
import type { Log } from 'miniflare';
import type { Observation } from '../../scripts/lib/coverage-evidence.ts';
import { observe } from '../../scripts/observation.ts';
import { startRuntime } from '../../scripts/runtime.ts';

const leases = resolve(tmpdir(), 'nook-test-ports');
export const testBuild = resolve(process.env.NOOK_BUILD ?? '.local/test-build');

async function probe(port: number) {
  const server = createServer();
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, accept);
  });
  await new Promise<void>((accept, reject) => {
    server.close((error) => (error ? reject(error) : accept()));
  });
}

async function reservePort() {
  const ephemeral =
    process.platform === 'linux'
      ? (await readFile('/proc/sys/net/ipv4/ip_local_port_range', 'utf8'))
          .trim()
          .split(/\s+/)
          .map(Number)
      : [32768, 60999];
  // Fetch's highest blocked port is 10080: https://fetch.spec.whatwg.org/#port-blocking
  const firstHttpPort = 10081;
  const [minimum, maximum] =
    ephemeral[0] > firstHttpPort
      ? [firstHttpPort, ephemeral[0]]
      : [Math.max(firstHttpPort, ephemeral[1] + 1), 65536];
  await mkdir(leases, { recursive: true });
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = randomInt(minimum, maximum);
    const path = resolve(leases, String(port));
    try {
      await mkdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    try {
      await probe(port);
      return { port, release: () => rmdir(path) };
    } catch (error) {
      await rmdir(path);
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('No test port available outside the ephemeral range.');
}

export async function runtime(
  options: {
    bindings?: Record<string, string>;
    directory?: string;
    outboundService?: (request: Request) => Promise<Response>;
    configPath?: string;
  } = {},
) {
  const lease = await reservePort();
  const origin = `http://127.0.0.1:${lease.port}`;
  let started: Awaited<ReturnType<typeof startRuntime>>;
  try {
    started = await startRuntime({
      port: lease.port,
      directory: options.directory ?? testBuild,
      configPath: options.configPath,
      bindings: options.bindings,
      outboundService: options.outboundService,
      coverage: Boolean(process.env.COVERAGE_RUN),
    });
  } catch (error) {
    await lease.release();
    throw error;
  }
  const { runtime: mf, settings: mfOptions } = started;
  return {
    origin,
    mf,
    setBindings(
      bindings: Record<string, string>,
      overrides: {
        outboundService?: (request: Request) => Promise<Response>;
        log?: Log;
        handleRuntimeStdio?: (stdout: Readable, stderr: Readable) => void;
      } = {},
    ) {
      return mf.setOptions({ ...mfOptions, bindings, ...overrides });
    },
    async close() {
      try {
        if (process.env.COVERAGE_RUN) {
          // Control traffic uses this runtime's HTTP dispatcher, independent of
          // client-test connections that may have closed or rejected a body.
          const response = await mf.dispatchFetch(`${origin}/__test/coverage`);
          await observe((await response.json()) as Observation);
        }
      } finally {
        try {
          await mf.dispose();
        } finally {
          await lease.release();
        }
      }
    },
  };
}

export type TestRuntime = Awaited<ReturnType<typeof runtime>>;

export function fetchWithHost(url: string, host: string): Promise<Response> {
  return new Promise((accept, reject) => {
    const request = httpRequest(
      url,
      { headers: { Host: host } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          accept(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode,
            }),
          ),
        );
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    request.end();
  });
}
