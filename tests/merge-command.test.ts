import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { expect, it } from 'vitest';
import type { Baseline } from '../scripts/lib/coverage-evidence.ts';
import { digest, sourceIdentity } from '../scripts/lib/identity.ts';
import { instrument, inventory } from '../scripts/lib/instrument.ts';
import { testEnvironment } from '../scripts/lib/test-environment.ts';

const command = resolve('scripts/coverage-merge.ts');

it.each(['complete', 'baseline', 'duplicate', 'artifact'] as const)(
  'E19: the real merge command checks %s shard evidence before replacing output',
  async (variant) => {
    const directory = await mkdtemp(resolve('.local', 'merge-command-'));
    const source = await sourceIdentity();
    const baseline: Baseline = {};
    for (const path of await inventory()) {
      const entry = await instrument(path);
      baseline[path] = { hash: entry.hash, baseline: entry.baseline };
    }
    const originalBaseline = JSON.stringify(baseline);
    const file = 'apps/worker/src/auth.ts';
    const observed = structuredClone(baseline[file].baseline);
    for (const id of Object.keys(observed.s)) observed.s[id] = 1;
    try {
      // An exact source export lets the actual command own output in a fixture cwd.
      for (const path of Object.keys(source.files)) {
        const target = resolve(directory, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, await readFile(path));
      }
      const directories = [];
      for (const index of [1, 2, 3]) {
        const shard = resolve(directory, 'shards', String(index));
        directories.push(shard);
        await mkdir(shard, { recursive: true });
        const different = structuredClone(baseline);
        delete different[file].baseline.fnMap['0'];
        const artifacts: Record<string, string> = {
          'baseline.json':
            variant === 'baseline' && index === 3
              ? JSON.stringify(different)
              : originalBaseline,
        };
        for (const seam of ['node', 'worker', 'browser']) {
          const name = `${seam}-fixture-${variant === 'duplicate' ? 1 : index}.json`;
          artifacts[name] = JSON.stringify({
            seam,
            loaded: { [file]: baseline[file].hash },
            counters: { [file]: observed },
          });
        }
        const outputs = Object.fromEntries(
          Object.entries(artifacts).map(([name, data]) => [name, digest(data)]),
        );
        if (variant === 'artifact' && index === 3)
          artifacts['worker-fixture-3.json'] += ' ';
        for (const [name, data] of Object.entries(artifacts))
          await writeFile(resolve(shard, name), data);
        await writeFile(
          resolve(shard, 'manifest.json'),
          JSON.stringify({ schema: 1, source, shard: `${index}/3`, outputs }),
        );
      }
      const output = resolve(directory, '.local/verification/coverage');
      await mkdir(output, { recursive: true });
      await writeFile(resolve(output, 'preserved.txt'), 'previous evidence');
      const result = spawnSync(process.execPath, [command, ...directories], {
        env: testEnvironment(resolve(directory, 'home')),
        cwd: directory,
        encoding: 'utf8',
        timeout: 10_000,
      });
      if (variant === 'complete') {
        expect(result.status).toBe(0);
        const merged = JSON.parse(
          await readFile(resolve(output, 'manifest.json'), 'utf8'),
        );
        expect(merged).toMatchObject({ schema: 1, source, shards: 3 });
        expect(Object.keys(merged.outputs).length).toBe(10);
        expect(await readFile(resolve(output, 'baseline.json'), 'utf8')).toBe(
          originalBaseline,
        );
      } else {
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(
          {
            baseline: /disagree.*baseline/,
            duplicate: /Repeated coverage artifact/,
            artifact: /Corrupt coverage artifact/,
          }[variant],
        );
        expect(await readFile(resolve(output, 'preserved.txt'), 'utf8')).toBe(
          'previous evidence',
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
