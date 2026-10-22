import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { Argument, CliError, Command } from 'effect/cli';
import cliPackage from '../package.json' with { type: 'json' };
import { declaration } from './arguments.ts';
import { CliFailure } from './errors.ts';
import { hostFor } from './host.ts';
import { run } from './run.ts';
import { runGrammar } from './run-arguments.ts';
import { login, logout, mcpHeader, whoami } from './session.ts';
import { vaultCheck, vaultList } from './vault.ts';
import { vaultCreate } from './vault-create.ts';
import { createGrammar } from './vault-create-arguments.ts';

type Usage = string | { readonly [command: string]: Usage };
const usage: Usage = {
  run: runGrammar.usage,
  vault: {
    check: 'nook vault check',
    list: 'nook vault list <bucket>',
    create: createGrammar.usage,
  },
  memory: {
    attach: 'nook memory attach <id> <path>',
    download: 'nook memory download <id> <name> [--output <path>]',
  },
  login: 'nook login <url>',
  whoami: 'nook whoami',
  logout: 'nook logout',
  'mcp-header': 'nook mcp-header',
  version: 'nook version',
};
function usageLines(node: Usage): string[] {
  return typeof node === 'string'
    ? [node]
    : Object.values(node).flatMap(usageLines);
}
// Prints the usage of the command that failed, or of every command below it.
function usageOf(commandPath: readonly string[]) {
  let node = usage;
  for (const name of commandPath.slice(1))
    if (typeof node !== 'string' && Object.hasOwn(node, name))
      node = node[name];
  return `Usage: ${usageLines(node).join(' | ')}`;
}
function failedPath(error: unknown) {
  return CliError.isCliError(error) && error._tag === 'ShowHelp'
    ? error.commandPath
    : [];
}

function missingVaultBucket(args: readonly string[]) {
  return args[0] === 'vault' && args[1] === 'list' && args.length === 2;
}
function creatingVault(args: readonly string[]) {
  return args[0] === 'vault' && args[1] === 'create' && args[2] !== '--help';
}

export async function execute(
  args: string[],
  options: {
    platform?: NodeJS.Platform;
    write?: (message: string) => void;
  } = {},
) {
  const write =
    options.write ??
    ((message: string) => process.stdout.write(`${message}\n`));
  const host = hostFor(options.platform ?? process.platform);
  const writeError =
    args[0] === 'mcp-header'
      ? (message: string) => process.stderr.write(`${message}\n`)
      : write;
  if (!host) {
    write('The Nook CLI supports Linux and macOS only.');
    return 1;
  }
  if (args[0] === 'run') return run(host, args.slice(1), write);
  if (missingVaultBucket(args)) {
    write(usageOf(['nook', 'vault', 'list']));
    return 1;
  }
  const command = Command.make('nook').pipe(
    Command.withSubcommands([
      Command.make('run', declaration(runGrammar)).pipe(
        Command.withDescription('Run a command with audited secrets.'),
      ),
      Command.make('vault').pipe(
        Command.withSubcommands([
          Command.make('check', {}, () => vaultCheck(host, write)).pipe(
            Command.withDescription('Check the secrets mapped in nook.json.'),
          ),
          Command.make(
            'list',
            { bucket: Argument.String('bucket') },
            ({ bucket }) => vaultList(host, bucket, write),
          ),
          Command.make('create', declaration(createGrammar)).pipe(
            Command.withDescription(
              'Store a new secret from stdin without overwriting.',
            ),
          ),
        ]),
      ),
      Command.make('login', { url: Argument.String('url') }, ({ url }) =>
        login(host, url, write),
      ),
      Command.make('whoami', {}, () => whoami(host, write)),
      Command.make('logout', {}, () => logout(host, write)),
      Command.make('mcp-header', {}, () => mcpHeader(host, write)),
      Command.make('version', {}, () =>
        Effect.sync(() =>
          write(JSON.stringify({ version: cliPackage.version })),
        ),
      ),
    ]),
  );
  return Effect.runPromise(
    (creatingVault(args)
      ? vaultCreate(host, args.slice(2), write)
      : Command.runWith(command, {
          version: cliPackage.version,
          renderErrors: false,
        })(args)
    ).pipe(
      Effect.provide(NodeServices.layer),
      Effect.as(0),
      Effect.catch((error) => {
        writeError(
          error instanceof CliFailure
            ? error.message
            : usageOf(failedPath(error)),
        );
        return Effect.succeed(1);
      }),
    ),
  );
}
