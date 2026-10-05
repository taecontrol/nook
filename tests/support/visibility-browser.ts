import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Browser, chromium } from 'playwright';
import { expect } from 'vitest';

export async function visibilityBrowser() {
  const profile = await mkdtemp(join(tmpdir(), 'nook-browser-'));
  const process = spawn(
    chromium.executablePath(),
    [
      '--headless=new',
      '--no-sandbox',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const exited = once(process, 'exit');
  let browser: Browser | undefined;
  const close = async () => {
    try {
      await browser?.close();
    } finally {
      process.kill();
      await exited;
      await rm(profile, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  };
  try {
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
