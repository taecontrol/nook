import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

interface Location {
  start: { line: number; column: number };
  end: { line: number; column: number };
}

interface Comment {
  value: string;
  loc: Location;
}

interface Options {
  baseline: string;
  baseRef: string;
}

interface Context {
  cwd: string;
  filename: string;
  options: [Options];
  sourceCode: { getAllComments(): Comment[] };
  report(problem: { loc: Location; message: string }): void;
}

type Counts = Record<string, number>;

interface Ratchet {
  allowed: Counts;
  current: Counts;
  stale: string[];
}

const fileStart = {
  start: { line: 1, column: 0 },
  end: { line: 1, column: 0 },
};

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function published({ baseline, baseRef }: Options, cwd: string) {
  try {
    git(cwd, ['rev-parse', '--verify', baseRef]);
  } catch {
    throw new Error(
      `The comment ratchet compares against ${baseRef}; fetch the base branch first.`,
    );
  }
  try {
    return JSON.parse(git(cwd, ['show', `${baseRef}:${baseline}`])) as Counts;
  } catch {
    return undefined;
  }
}

function load(options: Options, cwd: string): Ratchet {
  const current: Counts = JSON.parse(
    readFileSync(resolve(cwd, options.baseline), 'utf8'),
  );
  const base = published(options, cwd);
  const allowed = Object.fromEntries(
    Object.entries(current).map(([file, count]) => [
      file,
      base ? Math.min(count, base[file] ?? 0) : count,
    ]),
  );
  const stale = Object.keys(current).filter(
    (file) => !existsSync(resolve(cwd, file)),
  );
  return { allowed, current, stale };
}

let ratchet: Ratchet | undefined;
let staleReported = false;

function refuseDisableDirectives(file: string, comments: Comment[]) {
  for (const comment of comments)
    if (/\b(oxlint|eslint)-disable/.test(comment.value))
      throw new Error(
        `${file}:${comment.loc.start.line} disables lint rules, which would hide nook/no-comments. Delete the directive.`,
      );
}

function reportStale(context: Context, stale: string[]) {
  if (staleReported || stale.length === 0) return;
  staleReported = true;
  context.report({
    loc: fileStart,
    message: `Remove the ratchet entries for files that no longer exist from ${context.options[0].baseline}: ${stale.join(', ')}.`,
  });
}

function check(context: Context) {
  const file = relative(context.cwd, context.filename);
  const comments = context.sourceCode.getAllComments();
  refuseDisableDirectives(file, comments);
  ratchet ??= load(context.options[0], context.cwd);
  reportStale(context, ratchet.stale);
  const allowed = ratchet.allowed[file] ?? 0;
  if (comments.length > allowed) {
    for (const comment of comments)
      context.report({
        loc: comment.loc,
        message: `Comments are banned: ${file} has ${comments.length} and the ratchet allows ${allowed}, the lower of its entries in ${context.options[0].baseline} here and on ${context.options[0].baseRef}. Delete the comment, move its decision into an ADR, or file an issue for the workaround it excuses.`,
      });
  } else if (comments.length < (ratchet.current[file] ?? 0)) {
    context.report({
      loc: fileStart,
      message: `${file} now has ${comments.length} comments. Tighten the ratchet: set its entry in ${context.options[0].baseline} to ${comments.length}, or remove the entry at 0.`,
    });
  }
}

export default {
  meta: { name: 'nook' },
  rules: {
    'no-comments': {
      meta: {
        schema: [
          {
            type: 'object',
            properties: {
              baseline: { type: 'string' },
              baseRef: { type: 'string' },
            },
            required: ['baseline', 'baseRef'],
            additionalProperties: false,
          },
        ],
      },
      create(context: Context) {
        return { Program: () => check(context) };
      },
    },
  },
};
