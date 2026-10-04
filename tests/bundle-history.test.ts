import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const command = resolve('scripts/bundle-budget.ts');

it.each([
  'main equals HEAD',
  'two-parent merge',
  'lower ceiling in second merge parent',
  'independent HEAD',
  'independent origin/main',
  'independent main',
  'fractional history',
  'string history',
])(
  'E14: the real budget command preserves valid historical ceilings: %s',
  async (scenario) => {
    const directory = await mkdtemp(resolve('.local', 'budget-history-'));
    const environment = {
      ...process.env,
      GIT_DIR: resolve(directory, 'history.git'),
      GIT_WORK_TREE: undefined,
      GIT_COMMON_DIR: undefined,
      GIT_INDEX_FILE: undefined,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Synthetic Owner',
      GIT_AUTHOR_EMAIL: 'owner@nook.test',
      GIT_COMMITTER_NAME: 'Synthetic Owner',
      GIT_COMMITTER_EMAIL: 'owner@nook.test',
    };
    const git = (args: string[], input?: string) =>
      execFileSync('git', args, {
        cwd: directory,
        env: environment,
        input,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    const run = () =>
      spawnSync(process.execPath, [command], {
        cwd: directory,
        env: environment,
        encoding: 'utf8',
        timeout: 5_000,
      });
    let parent: string | undefined;
    const commit = async (
      ceiling: number | string,
      parents = parent ? [parent] : [],
      parallelWork = false,
    ) => {
      const contents = JSON.stringify({ initialJsGzipBytes: ceiling });
      await writeFile(resolve(directory, 'bundle-budget.json'), contents);
      const blob = git(['hash-object', '-w', '--stdin'], contents);
      let entries = `100644 blob ${blob}\tbundle-budget.json\n`;
      if (parallelWork) {
        const other = git(['hash-object', '-w', '--stdin'], 'Parallel work');
        entries += `100644 blob ${other}\tother.txt\n`;
      }
      const tree = git(['mktree'], entries);
      parent = git([
        'commit-tree',
        tree,
        ...parents.flatMap((revision) => ['-p', revision]),
        '-m',
        `Fixture ceiling ${ceiling}\n\nCo-Authored-By: GPT-6.1-Sol (Codex) <noreply@openai.com>`,
      ]);
      git(['update-ref', 'refs/heads/main', parent]);
      git(['update-ref', 'refs/remotes/origin/main', parent]);
      return parent;
    };
    try {
      // Bare synthetic history has no working tree; the project checkout stays untouched.
      execFileSync(
        'git',
        [
          'init',
          '--bare',
          '--quiet',
          '--initial-branch=main',
          environment.GIT_DIR,
        ],
        {
          cwd: directory,
          env: environment,
          stdio: 'ignore',
        },
      );
      await mkdir(resolve(directory, 'dist/assets'), { recursive: true });
      await writeFile(
        resolve(directory, 'dist/assets/index.html'),
        '<script src="/tiny.js"></script>',
      );
      await writeFile(
        resolve(directory, 'dist/assets/tiny.js'),
        'console.log("synthetic");',
      );
      await writeFile(
        resolve(directory, 'bundle-budget.json'),
        JSON.stringify({ initialJsGzipBytes: 200_000 }),
      );
      expect(run().status).toBe(0);
      const initial = await commit(200_000);
      expect(run().status).toBe(0);
      const lower = await commit(199_500);
      expect(run().status).toBe(0);
      if (
        scenario === 'two-parent merge' ||
        scenario === 'lower ceiling in second merge parent'
      ) {
        const parallel = await commit(200_000, [initial], true);
        const parents =
          scenario === 'two-parent merge'
            ? [lower, parallel]
            : [parallel, lower];
        await commit(200_000, parents, true);
      } else if (
        scenario === 'fractional history' ||
        scenario === 'string history'
      ) {
        await commit(scenario === 'fractional history' ? 199_500.5 : '199500');
        // The current ceiling is valid and lower; only malformed history rejects it.
        await writeFile(
          resolve(directory, 'bundle-budget.json'),
          JSON.stringify({ initialJsGzipBytes: 199_000 }),
        );
      } else {
        const increased = await commit(200_000);
        if (scenario === 'independent HEAD') {
          git(['update-ref', '--no-deref', 'HEAD', increased]);
          git(['update-ref', 'refs/heads/main', initial]);
          git(['update-ref', 'refs/remotes/origin/main', initial]);
        } else if (scenario === 'independent origin/main') {
          git(['update-ref', '--no-deref', 'HEAD', initial]);
          git(['update-ref', '-d', 'refs/heads/main']);
          git(['update-ref', 'refs/remotes/origin/main', lower]);
        } else if (scenario === 'independent main') {
          git(['update-ref', '--no-deref', 'HEAD', initial]);
          git(['update-ref', '-d', 'refs/remotes/origin/main']);
          git(['update-ref', 'refs/heads/main', lower]);
        }
      }
      const increase = run();
      expect(increase.status).toBe(1);
      expect(increase.stderr).toContain('may only go down');
      if (scenario === 'fractional history' || scenario === 'string history') {
        // Restore valid history before the original lower-ceiling positive control.
        git(['update-ref', 'refs/heads/main', lower]);
        git(['update-ref', 'refs/remotes/origin/main', lower]);
      }
      await writeFile(
        resolve(directory, 'bundle-budget.json'),
        JSON.stringify({ initialJsGzipBytes: 199_000 }),
      );
      expect(run().status).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
