import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { testEnvironment } from '../scripts/lib/test-environment.ts';

it('E29: the actual v0.3.2 failure mapping prints the approval update message and exits 1', async () => {
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
        contents: `import { runFailure } from 'released-run'; import { publicFailure } from 'released-api'; import { RequestFailure } from ${JSON.stringify(resolve('apps/cli/src/errors.ts'))}; export function mapped(message) { const server=publicFailure(JSON.stringify({_tag:'VaultNotConfigured',message}),503); const error=runFailure(new RequestFailure('Could not reach synthetic',server,server.message)); return {message:error.message,code:1}; }`,
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
    expect(mapped(message)).toEqual({ message, code: 1 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
