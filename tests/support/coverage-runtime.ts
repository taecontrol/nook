import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { startRuntime } from '../../scripts/runtime.ts';
import { runtime, testBuild } from './runtime.ts';

export async function coverageRuntime(invalidJson = false) {
  await mkdir('.local', { recursive: true });
  const directory = await mkdtemp(resolve('.local', 'coverage-runtime-'));
  try {
    await cp(resolve(testBuild, 'assets'), resolve(directory, 'assets'), {
      recursive: true,
    });
    await build({
      stdin: {
        contents: `import worker from ${JSON.stringify(resolve(testBuild, 'worker.js'))}; export default { fetch(request, env) { if (new URL(request.url).pathname === '/__test/coverage') return ${invalidJson ? "new Response('invalid json')" : "Response.json({ seam: 'worker', loaded: globalThis.__authoredModules__ ?? {}, counters: globalThis.__coverage__ ?? {} })"}; return worker.fetch(request, env); } };`,
        resolveDir: process.cwd(),
      },
      outfile: resolve(directory, 'worker.js'),
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      conditions: ['workerd', 'worker', 'browser'],
      external: ['node:*', 'cloudflare:*'],
      target: 'es2023',
    });
    const app = await runtime({ directory });
    return {
      ...app,
      async close() {
        try {
          await app.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

// A healthy workerd target behind a public HTTP connection that cannot be reused.
export async function closingClientRuntime(
  options: Parameters<typeof startRuntime>[0],
) {
  const started = await startRuntime({ ...options, port: 0 });
  const requests = new WeakSet<object>();
  const proxy = createServer(async (incoming, outgoing) => {
    if (requests.has(incoming.socket)) {
      incoming.socket.destroy();
      return;
    }
    requests.add(incoming.socket);
    const response = await started.runtime.dispatchFetch(
      `http://127.0.0.1${incoming.url}`,
    );
    const body = Buffer.from(await response.arrayBuffer());
    outgoing.writeHead(response.status, {
      'Content-Type': response.headers.get('Content-Type') ?? '',
      'Content-Length': body.length,
    });
    outgoing.end(body);
  });
  const dispose = started.runtime.dispose.bind(started.runtime);
  const closeProxy = () =>
    new Promise<void>((accept) => {
      proxy.close(() => accept());
      proxy.closeAllConnections();
    });
  try {
    await new Promise<void>((accept, reject) => {
      proxy.once('error', reject);
      proxy.listen(options.port, '127.0.0.1', accept);
    });
    started.runtime.dispose = async () => {
      try {
        await closeProxy();
      } finally {
        await dispose();
      }
    };
    return started;
  } catch (error) {
    await closeProxy();
    await dispose();
    throw error;
  }
}
