import { rm } from 'node:fs/promises';
import { chromium } from 'playwright';
import { temporaryTestHome, testEnvironment } from './test-environment.ts';

export async function browserEnvironment() {
  const home = await temporaryTestHome();
  return {
    home,
    options: {
      env: testEnvironment(home),
      args: ['--password-store=basic', '--use-mock-keychain'],
    },
    close: () => rm(home, { recursive: true, force: true }),
  };
}

export async function launchTestBrowser() {
  const environment = await browserEnvironment();
  try {
    const browser = await chromium.launch(environment.options);
    return {
      browser,
      async close() {
        try {
          await browser.close();
        } finally {
          await environment.close();
        }
      },
    };
  } catch (error) {
    await environment.close();
    throw error;
  }
}
