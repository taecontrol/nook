import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { testEnvironment } from '../scripts/lib/test-environment.ts';
import { privateKeyring } from './support/cli.ts';

it('E29: the actual v0.3.2 failure mapping prints the approval update message', async () => {
  const directory = await mkdtemp(resolve('.local', 'released-approval-'));
  try {
    const source = (path: string) =>
      execFileSync('git', ['show', `v0.3.2:apps/cli/src/${path}.ts`], {
        encoding: 'utf8',
        env: testEnvironment(process.env.HOME),
      });
    const outfile = resolve(directory, 'mapping.mjs');
    await build({
      stdin: {
        contents: `import { runFailure } from 'released-run'; import { publicFailure } from 'released-api'; import { RequestFailure } from ${JSON.stringify(resolve('apps/cli/src/errors.ts'))}; export function mapped(message) { const server=publicFailure(JSON.stringify({_tag:'VaultNotConfigured',message}),503); const error=runFailure(new RequestFailure('Could not reach synthetic',server,server.message)); return error.message; }`,
        resolveDir: process.cwd(),
      },
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      plugins: [
        {
          name: 'released-source',
          setup(builder) {
            builder.onResolve({ filter: /^released-(run|api)$/ }, (args) => ({
              path: args.path.slice(9),
              namespace: 'released',
            }));
            builder.onLoad({ filter: /.*/, namespace: 'released' }, (args) => ({
              contents: `${source(args.path)}\nexport { ${args.path === 'run' ? 'runFailure' : 'publicFailure'} };`,
              loader: 'ts',
              resolveDir: resolve('apps/cli/src'),
            }));
          },
        },
      ],
    });
    const { mapped } = await import(outfile);
    const message =
      "work/acme/STRIPE_KEY needs the owner's approval, and this nook version cannot ask. Update nook.";
    expect(mapped(message)).toBe(message);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function releasedCli(directory: string) {
  const env = testEnvironment(process.env.HOME);
  const archive = execFileSync(
    'git',
    [
      'archive',
      'v0.6.0',
      'apps/cli/src',
      'apps/cli/package.json',
      'packages/contract/src',
    ],
    { env, maxBuffer: 10 * 1024 * 1024 },
  );
  execFileSync('tar', ['-x', '-C', directory], { env, input: archive });
  const outfile = resolve(directory, 'cli.mjs');
  await build({
    entryPoints: [resolve(directory, 'apps/cli/src/index.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node26',
    external: ['node:*'],
    alias: {
      '@nook/contract': resolve(directory, 'packages/contract/src/index.ts'),
    },
    nodePaths: [resolve('apps/cli/node_modules'), resolve('node_modules')],
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });
  return outfile;
}

it.each([false, true])(
  'the actual v0.6.0 CLI prints its existing expiry message for changed (after pending: %s)',
  async (afterPending) => {
    const directory = await mkdtemp(resolve('.local', 'released-changed-'));
    const keyring = await privateKeyring();
    let calls = 0;
    const path = 'work/acme/KEY';
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) {
        /* Drain the request before responding. */
      }
      const pending = afterPending && ++calls === 1;
      response.writeHead(pending ? 200 : 410, {
        'Content-Type': 'application/json',
      });
      response.end(
        JSON.stringify(
          pending
            ? {
                approval: {
                  id: '00000000-0000-4000-8000-000000000001',
                  url: 'https://nook.test/approvals/request',
                  paths: [path],
                  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
                  expiresIn: 3,
                  interval: 2,
                },
              }
            : { _tag: 'ApprovalExpired', reason: 'changed' },
        ),
      );
    });
    try {
      const file = await releasedCli(directory);
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing synthetic port');
      const origin = `http://127.0.0.1:${address.port}`;
      await mkdir(dirname(keyring.config), { recursive: true });
      await writeFile(keyring.config, JSON.stringify({ url: origin }));
      expect(await keyring.store(origin, 'synthetic-released-token')).toBe(0);
      const result = await keyring.command(
        process.execPath,
        [
          file,
          'run',
          '--secret',
          `T=${path}`,
          '--purpose',
          'released compatibility',
          '--',
          process.execPath,
          '-e',
          'process.stdout.write("started")',
        ],
        {},
        '',
        keyring.home,
      ).done;
      expect(result.status).toBe(75);
      expect(result.stdout).toBe('');
      const announcement = afterPending
        ? `${path} needs the owner's approval.\nAsk the owner to open https://nook.test/approvals/request\nWaiting (0:03 left)…\n`
        : '';
      expect(result.stderr).toBe(
        `${announcement}The approval request expired. Run again to ask again.\n`,
      );
    } finally {
      await keyring.close();
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      await rm(directory, { recursive: true, force: true });
    }
  },
);
