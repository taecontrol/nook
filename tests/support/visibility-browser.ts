import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Browser, chromium } from 'playwright';
import { expect } from 'vitest';
import { browserEnvironment } from '../../scripts/lib/test-browser.ts';

export async function visibilityBrowser() {
  const environment = await browserEnvironment();
  const profile = await mkdtemp(join(environment.home, 'profile-'));
  const child = spawn(
    chromium.executablePath(),
    [
      ...environment.options.args,
      '--headless=new',
      '--no-sandbox',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { env: environment.options.env, stdio: 'ignore' },
  );
  const exited = once(child, 'exit').catch(() => undefined);
  let browser: Browser | undefined;
  const close = async () => {
    try {
      if (browser?.isConnected()) {
        // Closing a CDP connection only disconnects; shut down Chromium itself.
        const session = await browser.newBrowserCDPSession();
        await session.send('Browser.close');
      } else child.kill();
      await exited;
    } finally {
      child.kill();
      await exited;
      try {
        await browser?.close();
      } finally {
        await environment.close();
      }
    }
  };
  try {
    await once(child, 'spawn');
    const portFile = join(profile, 'DevToolsActivePort');
    await expect.poll(() => readFile(portFile, 'utf8')).toMatch(/^\d+\n/);
    const port = Number((await readFile(portFile, 'utf8')).split('\n')[0]);
    // Playwright's default focus emulation keeps background tabs visible.
    // The default CDP context with noDefaults preserves native visibility.
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
      noDefaults: true,
    });
    const context = browser.contexts()[0];
    return { context, page: context.pages()[0], close };
  } catch (error) {
    await close();
    throw error;
  }
}
