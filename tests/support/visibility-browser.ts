import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Browser, type BrowserContext, chromium } from 'playwright';
import { expect } from 'vitest';
import { browserEnvironment } from '../../scripts/lib/test-browser.ts';

const latePageWait = 1_000;
const elapsed = (from: number, to: number) => `${Math.round(to - from)} ms`;

// Issue #97: a rare CI run handed over a context without a page. Fail with
// what Chromium reported so the next occurrence shows why.
async function missingPage(
  browser: Browser,
  context: BrowserContext,
  launched: number,
  published: number,
) {
  const connected = performance.now();
  const late = context.waitForEvent('page', { timeout: latePageWait }).then(
    () => `a page appeared ${elapsed(connected, performance.now())} later`,
    () => `no page appeared within ${latePageWait} ms`,
  );
  const targets = await browser
    .newBrowserCDPSession()
    .then((session) => session.send('Target.getTargets'))
    .then(({ targetInfos }) =>
      targetInfos
        .map(({ type, url, attached }) => `${type} ${url} attached=${attached}`)
        .join(', '),
    )
    .catch((error: Error) => `unavailable (${error.message})`);
  return new Error(
    `The visibility browser connected without a page: DevToolsActivePort ${elapsed(launched, published)} after launch, connected ${elapsed(launched, connected)} after launch, ${await late}. Targets at connection: ${targets || 'none'}.`,
  );
}

export async function visibilityBrowser() {
  const environment = await browserEnvironment();
  const profile = await mkdtemp(join(environment.home, 'profile-'));
  const launched = performance.now();
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
    const published = performance.now();
    // Playwright's default focus emulation keeps background tabs visible.
    // The default CDP context with noDefaults preserves native visibility.
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
      noDefaults: true,
    });
    const context = browser.contexts()[0];
    const page = context.pages()[0];
    if (!page) throw await missingPage(browser, context, launched, published);
    return { context, page, close };
  } catch (error) {
    await close();
    throw error;
  }
}
