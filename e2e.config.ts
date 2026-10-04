import { web } from '@e2e-dev/web';
import type { E2EConfig } from 'e2e';
import { chatgpt } from 'e2e/oauth/chatgpt';

export default {
  tests: ['tests/journeys/**/*.e2e.ts'],
  retries: 0,
  cache: { mode: process.env.CI ? 'read-only' : 'read-write' },
  agents: { default: { model: chatgpt('gpt-6.1-sol') } },
  workers: 1,
  targets: [
    {
      name: 'chromium',
      engine: web({ viewport: { width: 1440, height: 900 } }),
      app: {
        url: 'http://127.0.0.1:0',
        command: {
          executable: 'pnpm',
          args: ['exec', 'node', 'scripts/serve.ts', '--port', '{port}'],
          env: {
            NOOK_BUILD: process.env.NOOK_BUILD ?? '.local/test-build',
            COVERAGE_RUN: process.env.COVERAGE_RUN ?? '',
          },
          log: '.e2e/logs/app.log',
        },
      },
    },
  ],
} satisfies E2EConfig;
