import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { jsonRequest } from './authorizations.ts';
import type { TestRuntime } from './runtime.ts';
import { secretInput } from './vault.ts';

export const createdPath = 'work/acme/NEW_TOKEN';
export function machineCreateInput(overrides: Record<string, unknown> = {}) {
  return {
    ...secretInput({
      name: 'NEW_TOKEN',
      description: 'Provider API token',
      ...overrides,
    }),
    purpose: 'token from provider setup',
    workingDirectory: '/synthetic/work/acme',
    ...overrides,
  };
}
export function machineCreate(
  app: TestRuntime,
  token: string | undefined,
  input = machineCreateInput(),
  headers: Record<string, string> = {},
) {
  return jsonRequest(app, '/api/machine/secrets', input, {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...headers,
  });
}
export const createArgs = (path = createdPath) => [
  'vault',
  'create',
  path,
  '--purpose',
  'token from provider setup',
];

// Only transport faults are synthetic; successful writes use the built Worker.
export async function createTransport(
  app: TestRuntime,
  before: (
    attempt: number,
  ) =>
    | 'lost'
    | 'hang'
    | 'open-error-body'
    | { status: number; body: unknown }
    | undefined,
  after?: (
    attempt: number,
    response: Response,
  ) => Promise<'lost' | 'partial-201' | undefined>,
) {
  const bodies: Buffer[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      bodies.push(body);
      const attempt = bodies.length;
      const fault = before(attempt);
      if (fault === 'hang') return;
      if (fault === 'lost') {
        response.destroy();
        return;
      }
      if (fault === 'open-error-body') {
        response.writeHead(502, { 'Content-Type': 'application/json' });
        response.flushHeaders();
        response.write('{"_tag":"FutureTransient"');
        return;
      }
      if (fault) {
        response.writeHead(fault.status, {
          'Content-Type': 'application/json',
        });
        response.end(JSON.stringify(fault.body));
        return;
      }
      const forwarded = await fetch(app.origin + '/api/machine/secrets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: request.headers.authorization ?? '',
        },
        body,
      });
      const responseFault = await after?.(attempt, forwarded.clone());
      if (responseFault === 'lost') {
        await forwarded.body?.cancel();
        response.destroy();
        return;
      }
      if (responseFault === 'partial-201') {
        const received = Buffer.from(await forwarded.arrayBuffer());
        response.writeHead(forwarded.status, {
          'Content-Type': 'application/json',
          'Content-Length': received.length,
          Connection: 'close',
        });
        response.end(received.subarray(0, 1));
        return;
      }
      response.writeHead(forwarded.status, {
        'Content-Type': 'application/json',
      });
      response.end(Buffer.from(await forwarded.arrayBuffer()));
    } catch {
      response.writeHead(503).end('{"_tag":"ServiceUnavailable"}');
    }
  });
  await new Promise<void>((accept) => server.listen(0, '127.0.0.1', accept));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    bodies,
    close: () =>
      new Promise<void>((accept) => {
        server.closeAllConnections();
        server.close(() => accept());
      }),
  };
}
