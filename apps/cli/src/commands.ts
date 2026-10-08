import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { Argument, Command, Flag } from 'effect/cli';
import cliPackage from '../package.json' with { type: 'json' };
import { CliFailure } from './errors.ts';
import { run } from './run.ts';
import { login, logout, mcpHeader, whoami } from './session.ts';
import { vaultCheck, vaultList } from './vault.ts';
import { vaultCreate } from './vault-create.ts';

function missingVaultBucket(args: readonly string[]) {
  return args[0] === 'vault' && args[1] === 'list' && args.length === 2;
}
function creatingVault(args: readonly string[]) {
  return args[0] === 'vault' && args[1] === 'create' && args[2] !== '--help';
}
function supportedPlatform(platform: NodeJS.Platform) {
  return platform === 'linux' || platform === 'darwin';
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
  const platform = options.platform ?? process.platform;
  const writeError =
    args[0] === 'mcp-header'
      ? (message: string) => process.stderr.write(`${message}\n`)
      : write;
  if (!supportedPlatform(platform)) {
    write('The Nook CLI supports Linux and macOS only.');
    return 1;
  }
  if (args[0] === 'run') return run(args.slice(1), write);
  if (missingVaultBucket(args)) {
    write('Usage: nook vault list <bucket>');
    return 1;
  }
  const command = Command.make('nook').pipe(
    Command.withSubcommands([
      Command.make('run').pipe(
        Command.withDescription('Run a command with audited secrets.'),
      ),
      Command.make('vault').pipe(
        Command.withSubcommands([
          Command.make('check', {}, () => vaultCheck(write)).pipe(
            Command.withDescription('Check the secrets mapped in nook.json.'),
          ),
          Command.make(
            'list',
            { bucket: Argument.String('bucket') },
            ({ bucket }) => vaultList(bucket, write),
          ),
          Command.make('create', {
            path: Argument.String('path'),
            purpose: Flag.String('purpose'),
            description: Flag.optional(Flag.String('description')),
          }).pipe(
            Command.withDescription(
              'Store a new secret from stdin without overwriting.',
            ),
          ),
        ]),
      ),
      Command.make('login', { url: Argument.String('url') }, ({ url }) =>
        login(url, write),
      ),
      Command.make('whoami', {}, () => whoami(write)),
      Command.make('logout', {}, () => logout(write)),
      Command.make('mcp-header', {}, () => mcpHeader(write)),
      Command.make('version', {}, () =>
        Effect.sync(() =>
          write(JSON.stringify({ version: cliPackage.version })),
        ),
      ),
    ]),
  );
  return Effect.runPromise(
    (creatingVault(args)
      ? vaultCreate(args.slice(2), write)
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
            : args[0] === 'vault'
              ? 'Usage: nook vault list <bucket>'
              : 'Usage: nook login <url> | nook whoami | nook logout | nook mcp-header | nook version',
        );
        return Effect.succeed(1);
      }),
    ),
  );
}
