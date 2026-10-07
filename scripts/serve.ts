import { randomBytes } from 'node:crypto';
import { startRuntime } from './runtime.ts';

const argument = process.argv.indexOf('--port');
const port = argument === -1 ? 4350 : Number(process.argv[argument + 1]);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('An explicit unprivileged port is required.');
const { runtime } = await startRuntime({
  port,
  directory: process.env.NOOK_BUILD ?? '.local/test-build',
  syntheticOwner: true,
  bindings: { VAULT_KEY: randomBytes(32).toString('base64') },
  coverage: Boolean(process.env.COVERAGE_RUN),
});
console.log(`Nook: http://127.0.0.1:${port}`);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    await runtime.dispose();
    process.exit(0);
  });
