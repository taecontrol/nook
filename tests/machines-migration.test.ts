import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { unstable_splitSqlQuery } from 'wrangler';
import { applyMigrations } from '../scripts/lib/migrations.ts';
import { ownerRuntime } from './support/authorizations.ts';
import {
  expectPrivate,
  listMachines,
  machineIdentity,
  revokeMachine,
} from './support/machines.ts';
import { runtime } from './support/runtime.ts';

it('E1/E2/E3: upgrading existing approvals preserves their credentials and dates, backfills independent ids, and starts with no last use', async () => {
  const app = await ownerRuntime(await runtime());
  try {
    const db = await app.mf.getD1Database('DB');
    const oldSchema = unstable_splitSqlQuery(
      await readFile('migrations/0003_machine_authorizations.sql', 'utf8'),
    ).find((sql) => sql.startsWith('CREATE TABLE machine_tokens'));
    expect(oldSchema).toBeDefined();
    await db.batch([
      db.prepare('DROP TABLE machine_tokens'),
      db.prepare(oldSchema ?? ''),
      db.prepare(
        "DELETE FROM d1_migrations WHERE name='0004_machine_management.sql'",
      ),
    ]);
    const tokens = [0, 1].map(
      () => `nook_${randomBytes(32).toString('base64url')}`,
    );
    const hashes = tokens.map((token) =>
      createHash('sha256').update(token).digest('hex'),
    );
    await db.batch(
      hashes.map((hash) =>
        db
          .prepare('INSERT INTO machine_tokens VALUES (?, ?, ?, ?)')
          .bind(
            hash,
            'framework-13',
            '"all"',
            Date.parse('2026-07-28T16:05:00.000Z'),
          ),
      ),
    );
    expect(await applyMigrations(db)).toEqual(['0004_machine_management.sql']);
    const machines = await listMachines(app);
    expect(machines).toHaveLength(2);
    expect(new Set(machines.map((machine) => machine.id)).size).toBe(2);
    expectPrivate(JSON.stringify(machines), [...tokens, ...hashes]);
    for (const machine of machines) {
      expect(machine.id.length).toBeGreaterThanOrEqual(16);
      expect(machine.approvedAt).toBe('2026-07-28T16:05:00.000Z');
      expect(machine.lastUsedAt).toBeNull();
    }
    for (const token of tokens)
      expect((await machineIdentity(app, token)).status).toBe(200);
    expect((await revokeMachine(app, machines[0].id)).status).toBe(204);
    expect(await listMachines(app)).toHaveLength(1);
    expect(
      (await Promise.all(tokens.map((token) => machineIdentity(app, token))))
        .map((response) => response.status)
        .sort(),
    ).toEqual([200, 401]);
  } finally {
    await app.close();
  }
});

it('E1/E2/E3/E7: approvals issued by the previous Worker after migration remain listed and independently revocable', async () => {
  const app = await ownerRuntime(await runtime());
  try {
    const db = await app.mf.getD1Database('DB');
    const tokens = [0, 1].map(
      () => `nook_${randomBytes(32).toString('base64url')}`,
    );
    const hashes = tokens.map((token) =>
      createHash('sha256').update(token).digest('hex'),
    );
    // Deploy applies migrations before replacing the Worker. Its old writer
    // continues to issue approvals using only these four columns in that gap.
    await db.batch(
      hashes.map((hash) =>
        db
          .prepare(
            'INSERT INTO machine_tokens(token_hash, machine_name, grant_json, created_at) VALUES (?, ?, ?, ?)',
          )
          .bind(
            hash,
            'framework-13',
            '"all"',
            Date.parse('2026-10-05T15:00:00Z'),
          ),
      ),
    );
    const machines = await listMachines(app);
    expect(machines).toHaveLength(2);
    expect(new Set(machines.map((machine) => machine.id)).size).toBe(2);
    expectPrivate(JSON.stringify(machines), [...tokens, ...hashes]);
    for (const machine of machines) {
      expect(machine.id.length).toBeGreaterThanOrEqual(16);
      expect(machine.approvedAt).toBe('2026-10-05T15:00:00.000Z');
      expect(machine.lastUsedAt).toBeNull();
    }
    expect((await revokeMachine(app, machines[0].id)).status).toBe(204);
    expect(await listMachines(app)).toHaveLength(1);
    expect(
      (await Promise.all(tokens.map((token) => machineIdentity(app, token))))
        .map((response) => response.status)
        .sort(),
    ).toEqual([200, 401]);
  } finally {
    await app.close();
  }
});
