import { execFileSync } from 'node:child_process';
import { assertBudget, checkBundleBudget } from './lib/bundle-budget.ts';

export {
  assertBudget,
  checkBundleBudget,
  initialScripts,
  measureInitialJs,
} from './lib/bundle-budget.ts';

function gitOutput(arguments_: string[]) {
  try {
    return execFileSync('git', arguments_, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // A first budget or a source export may have no Git history or main ref.
    return undefined;
  }
}

function previousBudget() {
  const revisions = new Set<string>();
  for (const ref of ['HEAD', 'origin/main', 'main']) {
    const history = gitOutput([
      'log',
      '--full-history',
      '--format=%H',
      ref,
      '--',
      'bundle-budget.json',
    ]);
    if (history)
      for (const revision of history.trim().split('\n'))
        revisions.add(revision);
  }
  let ceiling = 200_000;
  for (const revision of revisions) {
    const contents = gitOutput(['show', `${revision}:bundle-budget.json`]);
    if (!contents) continue;
    const prior = JSON.parse(contents).initialJsGzipBytes as number;
    assertBudget(prior, 200_000);
    ceiling = Math.min(ceiling, prior);
  }
  return ceiling;
}

if (import.meta.main) {
  const result = await checkBundleBudget();
  assertBudget(result.ceiling, previousBudget());
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
