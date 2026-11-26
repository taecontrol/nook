import { Effect } from 'effect';
import { Argument, Flag, type Param } from 'effect/cli';
import { CliFailure } from './errors.ts';

type Occurrence = 'required' | 'optional' | 'repeated' | 'boolean';
/**
 * The arguments of a command whose grammar effect/cli cannot parse: positional
 * arguments, then `--flag value` pairs, then, when `rest` is named, `--` and
 * everything after it verbatim. effect/cli keeps the first of a repeated flag,
 * prints the help document before a usage failure, and joins arguments before
 * `--` to those after it. These commands refuse a repeated flag, print one
 * usage line, and pass only what follows `--` through, untouched.
 */
export type Grammar = {
  readonly usage: string;
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, Occurrence>>;
  readonly rest?: string;
};
const flag: Record<Occurrence, (name: string) => Param.AnyFlag> = {
  required: (name) => Flag.String(name),
  optional: (name) => Flag.optional(Flag.String(name)),
  repeated: (name) => Flag.String(name).pipe(Flag.atLeast(0)),
  boolean: (name) => Flag.Boolean(name),
};
const readOnlyActions = new Set(['--help', '-h', '--version', '-v']);
// The same grammar as an effect/cli declaration, so help describes it.
export function declaration(grammar: Grammar) {
  const params: Record<string, Param.Any> = {};
  for (const name of grammar.positional) params[name] = Argument.String(name);
  for (const [name, occurrence] of Object.entries(grammar.flags))
    params[name] = flag[occurrence](name);
  if (grammar.rest)
    params[grammar.rest] = Argument.String(grammar.rest).pipe(
      Argument.variadic(),
    );
  return params;
}
function usageFailure(grammar: Grammar) {
  return new CliFailure(`Usage: ${grammar.usage}`);
}
function occurrence(
  grammar: Grammar,
  flag: string,
  flags: Map<string, string[]>,
) {
  const name = flag.slice(2);
  if (!flag.startsWith('--') || !Object.hasOwn(grammar.flags, name))
    return undefined;
  const occurs = grammar.flags[name];
  return flags.has(name) && occurs !== 'repeated' ? undefined : occurs;
}
function requireFlags(grammar: Grammar, flags: Map<string, string[]>) {
  return Effect.gen(function* () {
    for (const [name, occurs] of Object.entries(grammar.flags))
      if (occurs === 'required' && !flags.has(name))
        return yield* Effect.fail(new CliFailure(`A ${name} is required.`));
  });
}
function readFlags(grammar: Grammar, pairs: readonly string[]) {
  return Effect.gen(function* () {
    const flags = new Map<string, string[]>();
    for (let index = 0; index < pairs.length; index++) {
      if (readOnlyActions.has(pairs[index])) return pairs[index];
      const name = pairs[index].slice(2);
      const occurs = occurrence(grammar, pairs[index], flags);
      const values = flags.get(name) ?? [];
      if (!occurs) return yield* Effect.fail(usageFailure(grammar));
      const value = occurs === 'boolean' ? '' : pairs[++index];
      if (value === undefined) return yield* Effect.fail(usageFailure(grammar));
      flags.set(name, [...values, value]);
    }
    return flags;
  });
}
export function parseCommandArguments(
  grammar: Grammar,
  args: readonly string[],
) {
  return Effect.gen(function* () {
    if (readOnlyActions.has(args[0])) return args[0];
    const end = grammar.rest ? args.indexOf('--') : args.length;
    const count = grammar.positional.length;
    const positional = args.slice(0, count);
    const flags = yield* readFlags(grammar, args.slice(count, end));
    if (typeof flags === 'string') return flags;
    if (end < count || end === args.length - 1 || positional.some((v) => !v))
      return yield* Effect.fail(usageFailure(grammar));
    yield* requireFlags(grammar, flags);
    return {
      positional,
      flags,
      rest: args.slice(end + 1),
    };
  });
}
export function parseArguments(grammar: Grammar, args: readonly string[]) {
  return Effect.gen(function* () {
    const parsed = yield* parseCommandArguments(grammar, args);
    if (typeof parsed === 'string')
      return yield* Effect.fail(usageFailure(grammar));
    return parsed;
  });
}
