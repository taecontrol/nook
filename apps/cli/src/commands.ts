import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { Argument, Command } from 'effect/cli';
import { CliFailure } from './errors.ts';
import { login, logout, mcpHeader, whoami } from './session.ts';

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
  if (platform === 'darwin') {
    write('Keeping the token in the macOS Keychain is not supported yet.');
    return 1;
  }
  if (platform !== 'linux') {
    write('The Nook CLI currently supports Linux only.');
    return 1;
  }
  const command = Command.make('nook').pipe(
    Command.withSubcommands([
      Command.make('login', { url: Argument.String('url') }, ({ url }) =>
        login(url, write),
      ),
      Command.make('whoami', {}, () => whoami(write)),
      Command.make('logout', {}, () => logout(write)),
      Command.make('mcp-header', {}, () => mcpHeader(write)),
    ]),
  );
  return Effect.runPromise(
    Command.runWith(command, { version: '0.1.0', renderErrors: false })(
      args,
    ).pipe(
      Effect.provide(NodeServices.layer),
      Effect.as(0),
      Effect.catch((error) => {
        writeError(
          error instanceof CliFailure
            ? error.message
            : 'Usage: nook login <url> | nook whoami | nook logout | nook mcp-header',
        );
        return Effect.succeed(1);
      }),
    ),
  );
}
