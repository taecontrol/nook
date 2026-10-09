import { expect, it } from 'vitest';
import { machineCreate, machineCreateInput } from './support/agent-create.ts';
import { auditPageData } from './support/audit.ts';
import { issueGrant } from './support/grants.ts';
import { vaultRuntime } from './support/vault.ts';

// Returned by the public owner API at 9278ce8 after 26 machine creations with
// uppercase UUIDs. Keep this independent of newly generated audit IDs so a
// change to creation cannot hide incompatibility with previously issued cursors.
const historicalCreationCursor =
  'eyJhdCI6IjIwMjYtMTAtMDlUMTg6NDI6MzkuNzUxWiIsImlkIjoiQUFBQUFBQUEtQUFBQS00QUFBLThBQUEtMDAwMDAwMDAwMDAxIn0';

it('the owner can reuse a previously emitted uppercase creation cursor after its history is absent', async () => {
  const app = await vaultRuntime();
  try {
    const response = await fetch(
      `${app.origin}/api/audit?cursor=${encodeURIComponent(historicalCreationCursor)}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ entries: [], next: null });
  } finally {
    await app.close();
  }
});

it('the owner can consume the audit cursor emitted after uppercase UUID secret creations', async () => {
  const app = await vaultRuntime();
  try {
    const { token } = await issueGrant(app, ['work/acme']);
    for (let index = 0; index < 26; index++) {
      const input = machineCreateInput({
        name: `CURSOR_KEY_${index}`,
        writeId: `AAAAAAAA-AAAA-4AAA-8AAA-${index.toString(16).toUpperCase().padStart(12, '0')}`,
      });
      expect((await machineCreate(app, token, input)).status).toBe(201);
    }
    const first = await auditPageData(app);
    expect(first.entries).toHaveLength(25);
    const cursor = first.next;
    if (!cursor)
      throw new Error('The first audit page must offer its next cursor.');
    const response = await fetch(
      `${app.origin}/api/audit?cursor=${encodeURIComponent(cursor)}`,
    );
    expect(
      response.status,
      `The owner API must accept its emitted cursor: ${cursor}`,
    ).toBe(200);
    const last = (await response.json()) as Awaited<
      ReturnType<typeof auditPageData>
    >;
    expect(last.entries).toHaveLength(1);
    expect(last.next).toBeNull();
    expect(
      new Set([...first.entries, ...last.entries].map((entry) => entry.id))
        .size,
    ).toBe(26);
  } finally {
    await app.close();
  }
});
