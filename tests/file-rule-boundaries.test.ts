import { request } from 'node:http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { expectToolError } from './support/mcp.ts';
import { memoryClient } from './support/memory.ts';
import {
  attachFile,
  fileMemory,
  filePath,
  fileSnapshot,
  maximumFile,
  pdfName,
  seedFileMemory,
} from './support/memory-files.ts';
import { filesRuntime } from './support/memory-files-runtime.ts';

let app: Awaited<ReturnType<typeof filesRuntime>>;
let machine: Awaited<ReturnType<typeof seedFileMemory>>;
beforeAll(async () => {
  app = await filesRuntime();
  machine = await seedFileMemory(app);
  await attachFile(app, machine.token);
});
afterAll(() => app?.close());

it('the header-only size rejection retains its exact status and body', async () => {
  const response = await new Promise<{ status: number; body: string }>(
    (accept, reject) => {
      const input = request(
        app.origin + filePath(),
        {
          method: 'PUT',
          headers: { 'Content-Length': String(maximumFile + 1) },
        },
        (response) => {
          let body = '';
          response.on('data', (part) => {
            body += part;
          });
          response.on('end', () => {
            accept({ status: response.statusCode ?? 0, body });
            input.destroy();
          });
        },
      );
      input.on('error', reject);
      input.setTimeout(3000, () =>
        input.destroy(new Error('Size gate stalled.')),
      );
      input.flushHeaders();
    },
  );
  expect(response).toEqual({
    status: 413,
    body: '{"_tag":"FileTooLarge","message":"A file can be at most 25 MiB."}',
  });
});

it('HTTP decoding and JSON name validation return the same exact Unicode message', async () => {
  const response = await fetch(
    app.origin +
      filePath(fileMemory, 'surrogate.pdf').replace(
        'surrogate.pdf',
        '%ED%A0%80.pdf',
      ),
  );
  expect(response.status).toBe(400);
  expect(await response.text()).toBe(
    '{"_tag":"InvalidFile","message":"Use valid Unicode for the file name."}',
  );
  expectToolError(
    await memoryClient(app, '2026-07-28').call('detach', {
      id: fileMemory,
      name: 'lone\ud800.pdf',
      sha256: 'a'.repeat(64),
    }),
    'Use valid Unicode for the file name.',
  );
});

it('detach preserves its digest validation boundary and leaves rejected files unchanged', async () => {
  const before = await fileSnapshot(app);
  const client = memoryClient(app, '2026-07-28');
  for (const sha256 of [
    'A'.repeat(64),
    'a'.repeat(63),
    'a'.repeat(65),
    'g'.repeat(64),
    `${'a'.repeat(64)}\n`,
  ])
    expectToolError(
      await client.call('detach', { id: fileMemory, name: pdfName, sha256 }),
      'Use a lowercase SHA-256 digest for the file.',
    );
  expect(await fileSnapshot(app)).toEqual(before);
});
