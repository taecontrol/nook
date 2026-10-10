import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { type PrivateKeyring, privateKeyring } from './support/cli.ts';

it('private keyrings never use inherited XDG data and concurrent fixtures keep separate encrypted files', async () => {
  const inherited = await mkdtemp(resolve(tmpdir(), 'nook-inherited-data-'));
  const previousDataHome = process.env.XDG_DATA_HOME;
  const fixtures: PrivateKeyring[] = [];
  process.env.XDG_DATA_HOME = inherited;
  try {
    await Promise.all(
      [0, 1, 2].map(async () => fixtures.push(await privateKeyring())),
    );
    expect((await readdir(inherited)).length).toBe(0);
    for (const fixture of fixtures) {
      expect(
        existsSync(resolve(fixture.home, 'data/keyrings/login.keyring')),
        'The encrypted keyring is inside its own HOME',
      ).toBe(true);
    }
  } finally {
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousDataHome;
    await Promise.all(fixtures.map((fixture) => fixture.close()));
    await rm(inherited, { recursive: true, force: true });
  }
});

it('the CLI, private bus, host, daemon, and shims never inherit owner environment variables', async () => {
  vi.stubEnv('NOOK_LEAK_SENTINEL', 'synthetic-parent-only');
  vi.stubEnv('XDG_DATA_HOME', '/tmp/synthetic-owner/.local/share');
  vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/tmp/synthetic-owner/bus');
  vi.stubEnv('GNOME_KEYRING_CONTROL', '/tmp/synthetic-owner/keyring');
  const fixture = await privateKeyring();
  try {
    const hook = resolve(fixture.home, 'inspect-environment.mjs');
    await writeFile(
      hook,
      [
        "import { writeFileSync } from 'node:fs';",
        "import { resolve } from 'node:path';",
        "writeFileSync(resolve(process.env.HOME, 'environment.json'), JSON.stringify({ leaked: 'NOOK_LEAK_SENTINEL' in process.env, data: process.env.XDG_DATA_HOME, bus: process.env.DBUS_SESSION_BUS_ADDRESS, control: process.env.GNOME_KEYRING_CONTROL }));",
      ].join('\n'),
    );
    const result = await fixture.start(['--help'], {
      NODE_OPTIONS: `--import=${hook}`,
    }).done;
    expect(result.status).toBe(0);
    const report = JSON.parse(
      await readFile(resolve(fixture.home, 'environment.json'), 'utf8'),
    );
    expect(report.leaked, 'Parent variables must not reach the real CLI').toBe(
      false,
    );
    expect(report.data === resolve(fixture.home, 'data')).toBe(true);
    expect(
      decodeURIComponent(report.bus ?? '').includes(
        resolve(fixture.home, 'bus'),
      ),
    ).toBe(true);
    expect(report.control === undefined).toBe(true);
    const names: string[] = [];
    for (const pid of (await readdir('/proc')).filter((name) =>
      /^\d+$/.test(name),
    )) {
      try {
        const entries = (await readFile(`/proc/${pid}/environ`, 'utf8')).split(
          '\0',
        );
        if (!entries.includes(`HOME=${fixture.home}`)) continue;
        names.push((await readFile(`/proc/${pid}/comm`, 'utf8')).trim());
        expect(
          entries.some((entry) => entry.startsWith('NOOK_LEAK_SENTINEL=')),
          'Parent variables must not reach any private host process',
        ).toBe(false);
        expect(entries.includes(`XDG_DATA_HOME=${fixture.home}/data`)).toBe(
          true,
        );
        expect(
          entries.includes(
            'DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/synthetic-owner/bus',
          ),
        ).toBe(false);
      } catch (error) {
        if (
          !['ENOENT', 'EACCES', 'ESRCH'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
          )
        )
          throw error;
      }
    }
    expect(names.includes('gnome-keyring-d')).toBe(true);
    expect(names.includes('dbus-daemon')).toBe(true);
    // A shim receives the same fresh environment as the CLI.
    await writeFile(
      resolve(fixture.shim, 'secret-tool'),
      '#!/bin/sh\nif [ -z "$NOOK_LEAK_SENTINEL" ]; then echo isolated; else echo leaked; fi > "$HOME/shim-environment"\nexec /usr/bin/secret-tool "$@"\n',
      { mode: 0o700 },
    );
    await fixture.start(['login', 'http://127.0.0.1:1']).done;
    expect(
      (
        await readFile(resolve(fixture.home, 'shim-environment'), 'utf8')
      ).trim(),
    ).toBe('isolated');
  } finally {
    await fixture.close();
    vi.unstubAllEnvs();
  }
});

it.runIf(process.platform === 'linux')(
  'a child that closes stdin leaves the private fixture usable',
  async () => {
    const fixture = await privateKeyring('absent');
    try {
      const result = await fixture.command(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "import { closeSync } from 'node:fs'; closeSync(0); process.stdout.write('stdin-closed'); setTimeout(() => {}, 50);",
        ],
        {},
        'x'.repeat(2 * 1024 * 1024),
      ).done;
      expect(result).toMatchObject({ status: 0, stdout: 'stdin-closed' });
      expect(
        await fixture.command(process.execPath, [
          '-e',
          "process.stdout.write('fixture-survived')",
        ]).done,
      ).toMatchObject({ status: 0, stdout: 'fixture-survived' });
    } finally {
      await fixture.close();
    }
  },
);
