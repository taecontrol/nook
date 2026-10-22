import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { expect } from 'vitest';
import type { PrivateKeyring } from './cli.ts';
import type { TestRuntime } from './runtime.ts';

export async function configureFilesCli(
  keyring: PrivateKeyring,
  origin: string,
  token: string,
) {
  await mkdir(dirname(keyring.config), { recursive: true });
  await writeFile(keyring.config, JSON.stringify({ url: origin }));
  expect(await keyring.store(origin, token)).toBe(0);
}
// The proxy changes transport delivery, never file application behavior. Normal
// requests and bytes always come from the built Worker and its real local R2.
export async function fileTransport(
  app: TestRuntime,
  options: {
    before?: (method: string, path: string) => Promise<Response | undefined>;
    after?: (response: Response, path: string) => Promise<Response>;
  } = {},
) {
  const requests: { method: string; path: string }[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const method = request.method ?? 'GET';
      const path = request.url ?? '/';
      requests.push({ method, path });
      const injected = await options.before?.(method, path);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (
          value !== undefined &&
          ![
            'host',
            'connection',
            'transfer-encoding',
            'content-length',
          ].includes(name)
        )
          headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const upstream =
        injected ??
        (await fetch(app.origin + path, {
          method,
          headers,
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        }));
      const delivered = (await options.after?.(upstream, path)) ?? upstream;
      response.writeHead(delivered.status, {
        ...Object.fromEntries(delivered.headers),
        Connection: 'close',
      });
      response.end(Buffer.from(await delivered.arrayBuffer()));
    } catch {
      response.destroy();
    }
  });
  await new Promise<void>((accept) => server.listen(0, '127.0.0.1', accept));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Attachment proxy did not bind.');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((accept) => {
        server.close(() => accept());
        server.closeAllConnections();
      }),
  };
}
