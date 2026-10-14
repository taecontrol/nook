import { createHash } from 'node:crypto';
import type { Browser, Page } from 'playwright';
import {
  type FixtureMemory,
  memories,
  type ScenarioName,
  scenarios,
} from '../fixtures/memory-history.ts';
import { seedGrantTree } from './grants.ts';
import { memoryPage, seedMemories } from './memory.ts';
import type { TestRuntime } from './runtime.ts';

export { memories, type ScenarioName, scenarios };
export async function seedHistory(
  app: TestRuntime,
  fixtures: FixtureMemory[] = memories,
) {
  const db = await app.mf.getD1Database('DB');
  for (const memory of fixtures) {
    await seedGrantTree(
      app,
      memory.bucket
        .split('/')
        .map((_, i, parts) => parts.slice(0, i + 1).join('/')),
    );
    const at = (minutesAgo: number) =>
      new Date(
        Date.UTC(2026, 9, 13, 15, 21) - minutesAgo * 60_000,
      ).toISOString();
    const first = memory.versions[0];
    await seedMemories(app, [
      {
        id: memory.id,
        bucket: memory.bucket,
        content: first.content,
        tags: first.tags,
        createdAt: at(first.minutesAgo),
        ...first.author,
      },
    ]);
    for (let index = 1; index < memory.versions.length; index++) {
      const v = memory.versions[index];
      const { client, principal, workingDirectory } = v.author;
      await db.batch([
        db
          .prepare(
            'INSERT INTO memory_versions(memory_id,version,content,tags,client_name,client_version,principal,machine_id,machine_name,working_directory,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          )
          .bind(
            memory.id,
            index + 1,
            v.content,
            JSON.stringify(v.tags),
            client.name,
            client.version,
            principal.kind,
            principal.kind === 'machine' ? principal.id : null,
            principal.kind === 'machine' ? principal.name : null,
            workingDirectory,
            at(v.minutesAgo),
          ),
        db
          .prepare(
            'UPDATE memories SET current_version=?,content_hash=?,updated_at=? WHERE id=?',
          )
          .bind(
            index + 1,
            createHash('sha256').update(v.content).digest('hex'),
            at(v.minutesAgo),
            memory.id,
          ),
      ]);
    }
  }
}
export function historyPage(
  browser: Browser,
  options: {
    scenario?: ScenarioName;
    state?: string;
    viewport?: { width: number; height: number };
    colorScheme?: 'light' | 'dark';
    configure?: (page: Page, app: TestRuntime) => Promise<void>;
  } = {},
) {
  return memoryPage(browser, {
    seeds: [],
    start:
      scenarios[options.scenario ?? 'typical'].start + (options.state ?? ''),
    viewport: options.viewport,
    colorScheme: options.colorScheme,
    configure: async (page, app) => {
      await seedHistory(app);
      await options.configure?.(page, app);
    },
  });
}
