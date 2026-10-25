import { afterEach, expect, it } from 'vitest';
import { auditRows } from './support/audit.ts';
import { memoryClient } from './support/memory.ts';
import {
  attachFile,
  fileMemory,
  filePath,
  pdfName,
  seedFileMemory,
} from './support/memory-files.ts';
import {
  type FilesRuntime,
  filesRuntime,
} from './support/memory-files-runtime.ts';

let app: FilesRuntime;
afterEach(() => app?.close());

it.each([
  { endpoint: 'owner', protocol: '2026-07-28' },
  { endpoint: 'owner', protocol: '2025-06-18' },
  { endpoint: 'machine', protocol: '2026-07-28' },
  { endpoint: 'machine', protocol: '2025-06-18' },
] as const)(
  'file audit retains the HTTP and $endpoint MCP actors and clients under $protocol',
  async ({ endpoint, protocol }) => {
    app = await filesRuntime();
    const machine = await seedFileMemory(app);
    await app.setBindings(app.bindings, { cf: { country: 'AR' } });
    const upload = await fetch(app.origin + filePath(), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${machine.token}`,
        'Content-Type': 'application/pdf',
        'User-Agent': 'plain-cli',
        'CF-Connecting-IP': '203.0.113.9',
      },
      body: Buffer.from('actor provenance fixture'),
    });
    expect(upload.status).toBe(200);
    const stored = (await upload.json()) as { sha256: string };
    const downloaded = await fetch(app.origin + filePath(), {
      headers: {
        Authorization: `Bearer ${machine.token}`,
        'User-Agent': 'machine-reader/2.5 extra/1.0',
        'CF-Connecting-IP': '203.0.113.9',
      },
    });
    expect(downloaded.status).toBe(200);
    await downloaded.arrayBuffer();
    const ownerDownload = await fetch(
      app.origin + filePath(fileMemory, pdfName, false),
      {
        headers: {
          'User-Agent': 'owner-reader/4.0',
          'CF-Connecting-IP': '203.0.113.9',
        },
      },
    );
    expect(ownerDownload.status).toBe(200);
    await ownerDownload.arrayBuffer();
    const client = memoryClient(app, protocol, {
      machine: endpoint === 'machine',
      headers: {
        Authorization: `Bearer ${machine.token}`,
        'User-Agent': 'fallback/9.0',
        'CF-Connecting-IP': '203.0.113.9',
      },
    });
    expect(
      (
        await client.call('detach', {
          id: fileMemory,
          name: pdfName,
          sha256: stored.sha256,
        })
      ).isError,
    ).not.toBe(true);
    await attachFile(app, machine.token, { name: 'forgotten.pdf' });
    expect(
      (await client.call('forget', { id: fileMemory, expectedVersion: 1 }))
        .isError,
    ).not.toBe(true);

    const rows = await auditRows(app);
    const actor = {
      machine_id: machine.id,
      machine_name: 'LG16',
      ip: null,
      country: null,
    };
    expect(
      rows.find(
        (row) => row.outcome === 'file_attached' && row.file_name === pdfName,
      ),
    ).toMatchObject({
      ...actor,
      client_name: 'plain-cli',
      client_version: null,
    });
    expect(rows.filter((row) => row.outcome === 'file_downloaded')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ...actor,
          client_name: 'machine-reader',
          client_version: '2.5',
        }),
        expect.objectContaining({
          machine_id: null,
          machine_name: null,
          client_name: 'owner-reader',
          client_version: '4.0',
          ip: '203.0.113.9',
          country: 'AR',
        }),
      ]),
    );
    for (const outcome of ['file_detached', 'file_forgotten'])
      expect(rows.find((row) => row.outcome === outcome)).toMatchObject({
        machine_id: endpoint === 'machine' ? machine.id : null,
        machine_name: endpoint === 'machine' ? 'LG16' : null,
        client_name: protocol === '2026-07-28' ? 'claude-code' : 'fallback',
        client_version: protocol === '2026-07-28' ? '2.1.289' : '9.0',
        ip: null,
        country: null,
      });
    expect(rows).toHaveLength(6);
  },
);
