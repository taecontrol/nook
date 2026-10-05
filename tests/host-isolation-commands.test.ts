import { spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  temporaryTestHome,
  testEnvironment,
  unavailableSessionBus,
} from '../scripts/lib/test-environment.ts';

it('the direct journey command isolates E2E and preserves strict-cache, arguments, and exit status', async () => {
  const home = await temporaryTestHome('/tmp/nook-command-parent-');
  const report = resolve(home, 'environment.json');
  const shim = resolve(home, 'config/pnpm');
  try {
    await writeFile(
      shim,
      [
        '#!/usr/bin/env node',
        "import {writeFileSync} from 'node:fs';",
        `writeFileSync(${JSON.stringify(report)}, JSON.stringify({args:process.argv.slice(2), leaked:'NOOK_LEAK_SENTINEL' in process.env, bus:process.env.DBUS_SESSION_BUS_ADDRESS, home:process.env.HOME, directories:['XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','XDG_RUNTIME_DIR','TMPDIR'].map(name=>process.env[name])}));`,
        'process.exit(Number(process.argv.at(-1)));',
      ].join('\n'),
      { mode: 0o700 },
    );
    for (const status of [0, 7]) {
      const env = testEnvironment(home, {
        PATH: `${resolve(home, 'config')}:${process.env.PATH}`,
      });
      env.NOOK_LEAK_SENTINEL = 'synthetic-parent-only';
      env.DBUS_SESSION_BUS_ADDRESS =
        'unix:path=/tmp/synthetic-owner-session/bus';
      env.XDG_DATA_HOME = resolve(home, 'synthetic-owner-data');
      const result = spawnSync(
        process.execPath,
        [resolve('scripts/journey.ts'), '--shard', '1/3', String(status)],
        { env, encoding: 'utf8', timeout: 10_000 },
      );
      expect(result.status).toBe(status);
      const observed = JSON.parse(await readFile(report, 'utf8'));
      expect(observed.args).toEqual([
        'exec',
        'e2e',
        'run',
        '--strict-cache',
        '--shard',
        '1/3',
        String(status),
      ]);
      expect(observed.leaked).toBe(false);
      expect(observed.bus).toBe(unavailableSessionBus(observed.home));
      expect(observed.home === home).toBe(false);
      expect(
        observed.directories.every((path: string) =>
          path.startsWith(`${observed.home}/`),
        ),
      ).toBe(true);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
