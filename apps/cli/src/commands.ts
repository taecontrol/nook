import { NodeServices } from '@effect/platform-node';
import { Effect, Option } from 'effect';
import { Argument, CliError, Command, Flag } from 'effect/cli';
import cliPackage from '../package.json' with { type: 'json' };
import { declaration } from './arguments.ts';
import { CliFailure } from './errors.ts';
import { hostFor } from './host.ts';
import { memoryAttach, memoryDownload } from './memory-files.ts';
import { run } from './run.ts';
import { runGrammar } from './run-arguments.ts';
import { login, logout, mcpHeader, whoami } from './session.ts';
import { vaultCheck, vaultList } from './vault.ts';
import { vaultCreate } from './vault-create.ts';
import { createGrammar } from './vault-create-arguments.ts';
import { vaultImport } from './vault-import.ts';
import { importGrammar } from './vault-import-arguments.ts';

const grammarCommands = [
  {
    path: ['vault', 'create'],
    grammar: createGrammar,
    handler: vaultCreate,
    description: 'Store a new secret from stdin without overwriting.',
  },
  {
    path: ['vault', 'import'],
    grammar: importGrammar,
    handler: vaultImport,
    description: 'Import a .env file without overwriting existing secrets.',
  },
] as const;
type Usage = string | { readonly [command: string]: Usage };
const usage: Usage = {
  run: runGrammar.usage,
  vault: {
    check: 'nook vault check',
    list: 'nook vault list <bucket>',
    ...Object.fromEntries(
      grammarCommands.map(({ path, grammar }) => [path[1], grammar.usage]),
    ),
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
function grammarCommand(args: readonly string[]) {
  return grammarCommands.find(
    ({ path }) =>
      path.every((name, index) => args[index] === name) &&
      args[path.length] !== '--help',
  );
}

async function runInterruptible(effect: Effect.Effect<number>) {
  const controller = new AbortController();
  let interrupted = 0;
  const interrupt = () => {
    interrupted = 130;
    controller.abort();
  };
  const terminate = () => {
    interrupted = 143;
    controller.abort();
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    return await Effect.runPromise(effect, { signal: controller.signal });
  } catch (error) {
    if (interrupted) return interrupted;
    throw error;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
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
  if (args[0] === 'run')
    return run(host, args.slice(1), write, (message) =>
      process.stderr.write(`${message}\n`),
    );
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
          // Help has always listed import before create; usage lists create first.
          ...grammarCommands
            .toReversed()
            .map(({ path, grammar, description }) =>
              Command.make(path[1], declaration(grammar)).pipe(
                Command.withDescription(description),
              ),
            ),
        ]),
      ),
      Command.make('memory').pipe(
        Command.withSubcommands([
          Command.make(
            'attach',
            { id: Argument.String('id'), path: Argument.String('path') },
            ({ id, path }) => memoryAttach(host, id, path, write),
          ),
          Command.make(
            'download',
            {
              id: Argument.String('id'),
              name: Argument.String('name'),
              output: Flag.optional(Flag.String('output')),
            },
            ({ id, name, output }) =>
              memoryDownload(
                host,
                id,
                name,
                Option.getOrUndefined(output),
                write,
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
  const parsedCommand = grammarCommand(args);
  return runInterruptible(
    (parsedCommand
      ? parsedCommand.handler(
          host,
          args.slice(parsedCommand.path.length),
          write,
        )
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
