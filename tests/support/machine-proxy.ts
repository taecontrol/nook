import { createServer } from 'node:http';
import type { TestRuntime } from './runtime.ts';

type RequestInfo = { method: string; path: string };
export async function machineProxy(
  app: TestRuntime,
  fault: (request: RequestInfo) => 'hang' | number | undefined,
  observe?: (response: Response, request: RequestInfo) => Promise<void>,
) {
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const info = {
        method: request.method ?? 'GET',
        path: request.url ?? '/',
      };
      const injected = fault(info);
      if (injected === 'hang') return;
      if (injected !== undefined) {
        response.writeHead(injected, { 'Content-Type': 'application/json' });
        response.end('{"_tag":"ServiceUnavailable"}');
        return;
      }
      const forwarded = await fetch(`${app.origin}${info.path}`, {
        method: info.method,
        headers: {
          'Content-Type': 'application/json',
          ...(request.headers.authorization
            ? { Authorization: request.headers.authorization }
            : {}),
        },
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      await observe?.(forwarded.clone(), info);
      response.writeHead(forwarded.status, {
        'Content-Type':
          forwarded.headers.get('Content-Type') ?? 'application/json',
      });
      response.end(Buffer.from(await forwarded.arrayBuffer()));
    } catch {
      response.writeHead(503).end();
    }
  });
  await new Promise<void>((accept) => server.listen(0, '127.0.0.1', accept));
  const address = server.address();
  if (typeof address !== 'object' || !address)
    throw new Error('Machine proxy unavailable');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((accept) => {
        server.close(() => accept());
        server.closeAllConnections();
      }),
  };
}
