import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { expect, it, vi } from 'vitest';
import { fingerprintDirectory } from '../scripts/lib/host-resources.ts';
import * as browserSupport from '../scripts/lib/test-browser.ts';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import {
  temporaryTestHome,
  unavailableSessionBus,
} from '../scripts/lib/test-environment.ts';
import { visibilityBrowser } from './support/visibility-browser.ts';

const directoryNames = [
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'TMPDIR',
];
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

it.each(['visibility', 'Playwright'] as const)(
  'the %s browser owns a temporary HOME and uses the basic password store without the owner session bus',
  async (name) => {
    const owner = await temporaryTestHome('/tmp/nook-synthetic-browser-owner-');
    const report = resolve(owner, 'launch.json');
    const inspect = resolve(owner, 'inspect.mjs');
    const launcher = resolve(owner, 'chromium');
    const executable = chromium.executablePath();
    const realLaunch = chromium.launch.bind(chromium);
    await writeFile(
      inspect,
      [
        "import {writeFileSync} from 'node:fs';",
        'const home = process.env.HOME; const args = process.argv.slice(2);',
        `writeFileSync(${JSON.stringify(report)}, JSON.stringify({home, directories:${JSON.stringify(directoryNames)}.map(name=>process.env[name]), bus:process.env.DBUS_SESSION_BUS_ADDRESS, basic:args.includes("--password-store=basic"), mock:args.includes("--use-mock-keychain"), profile:args.find(arg=>arg.startsWith("--user-data-dir="))?.slice(16), leaked:"NOOK_LEAK_SENTINEL" in process.env}));`,
      ].join('\n'),
    );
    await writeFile(
      launcher,
      [
        '#!/bin/sh',
        `${shellQuote(process.execPath)} ${shellQuote(inspect)} "$@"`,
        `exec ${shellQuote(executable)} "$@"`,
      ].join('\n'),
      { mode: 0o700 },
    );
    vi.stubEnv('HOME', owner);
    vi.stubEnv('XDG_DATA_HOME', resolve(owner, 'data'));
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', `unix:path=${owner}/bus`);
    vi.stubEnv('NOOK_LEAK_SENTINEL', 'synthetic-parent-only');
    const spy =
      name === 'visibility'
        ? vi.spyOn(chromium, 'executablePath').mockReturnValueOnce(launcher)
        : vi
            .spyOn(chromium, 'launch')
            .mockImplementationOnce((options) =>
              realLaunch({ ...options, executablePath: launcher }),
            );
    let browser: { close: () => Promise<void> } | undefined;
    let home: string | undefined;
    try {
      browser = await (name === 'visibility'
        ? visibilityBrowser()
        : launchTestBrowser());
      const observed = JSON.parse(await readFile(report, 'utf8'));
      home = observed.home;
      expect(observed.basic).toBe(true);
      expect(observed.mock).toBe(true);
      expect(home === owner).toBe(false);
      expect(home?.startsWith('/tmp/nook-test-run-')).toBe(true);
      expect(observed.profile?.startsWith('/tmp/')).toBe(true);
      expect(observed.profile?.startsWith(`${owner}/`)).toBe(false);
      expect(
        observed.directories.every((path: string) =>
          path.startsWith(`${home}/`),
        ),
      ).toBe(true);
      expect(observed.bus).toBe(unavailableSessionBus(home as string));
      expect(observed.leaked).toBe(false);
    } finally {
      await browser?.close();
      spy.mockRestore();
      vi.unstubAllEnvs();
      await rm(owner, { recursive: true, force: true });
    }
    expect(await fingerprintDirectory(home as string)).toBe('absent');
  },
);

it('a failed Chromium launch removes its temporary HOME', async () => {
  const launch = vi
    .spyOn(chromium, 'launch')
    .mockRejectedValueOnce(new Error('Synthetic launch failure.'));
  try {
    await expect(launchTestBrowser()).rejects.toThrow(
      'Synthetic launch failure.',
    );
    const home = launch.mock.calls[0][0]?.env?.HOME;
    expect(home?.startsWith('/tmp/nook-test-run-')).toBe(true);
    expect(await fingerprintDirectory(home as string)).toBe('absent');
  } finally {
    launch.mockRestore();
  }
});

it('a missing visibility Chromium executable removes its temporary HOME', async () => {
  const environment = await browserSupport.browserEnvironment();
  const factory = vi
    .spyOn(browserSupport, 'browserEnvironment')
    .mockResolvedValueOnce(environment);
  const executable = vi
    .spyOn(chromium, 'executablePath')
    .mockReturnValueOnce(resolve(environment.home, 'missing-chromium'));
  try {
    await expect(visibilityBrowser()).rejects.toThrow('ENOENT');
    expect(await fingerprintDirectory(environment.home)).toBe('absent');
  } finally {
    factory.mockRestore();
    executable.mockRestore();
    await environment.close();
  }
});

async function connectWithoutPages(arrives: boolean) {
  const environment = await browserSupport.browserEnvironment();
  const factory = vi
    .spyOn(browserSupport, 'browserEnvironment')
    .mockResolvedValueOnce(environment);
  const realConnect = chromium.connectOverCDP.bind(chromium);
  let late: Promise<Page> | undefined;
  const connect = vi
    .spyOn(chromium, 'connectOverCDP')
    .mockImplementationOnce((async (
      ...args: Parameters<typeof realConnect>
    ) => {
      const browser = await realConnect(...args);
      const context = browser.contexts()[0];
      // Reproduces #97: the connection attaches before Chromium's startup tab.
      vi.spyOn(context, 'pages').mockReturnValueOnce([]);
      if (arrives)
        late = new Promise((accept) =>
          setTimeout(() => accept(context.newPage()), 200),
        );
      return browser;
    }) as typeof realConnect);
  return {
    home: environment.home,
    late: () => late,
    async restore() {
      factory.mockRestore();
      connect.mockRestore();
      await environment.close();
    },
  };
}

it('a visibility startup page that arrives after the connection is handed over', async () => {
  const connection = await connectWithoutPages(true);
  let browser: Awaited<ReturnType<typeof visibilityBrowser>> | undefined;
  try {
    browser = await visibilityBrowser();
    expect(browser.page).toBe(await connection.late());
    expect(await browser.page.evaluate(() => document.readyState)).toBe(
      'complete',
    );
  } finally {
    await browser?.close();
    await connection.restore();
  }
  expect(await fingerprintDirectory(connection.home)).toBe('absent');
});

it('a visibility context whose startup page never arrives fails with Chromium evidence', async () => {
  const connection = await connectWithoutPages(false);
  try {
    const failure = visibilityBrowser();
    await expect(failure).rejects.toThrow(
      /^The visibility browser has no startup page 5000 ms after connecting: DevToolsActivePort \d+ ms after launch, connected \d+ ms after launch\. Targets now: (.+, )?page about:blank attached=true[,.]/,
    );
    expect(await fingerprintDirectory(connection.home)).toBe('absent');
  } finally {
    await connection.restore();
  }
});
