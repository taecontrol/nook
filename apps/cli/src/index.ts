import { execute } from './commands.ts';
import { relayMain } from './relay.ts';

// Catch defects at the process boundary without printing a cause or process argv.
try {
  if (process.argv[2] === '--nook-output-relay') await relayMain();
  else process.exitCode = await execute(process.argv.slice(2));
} catch {
  process.stderr.write('Nook could not complete the command. Try again.\n');
  process.exitCode = 1;
}
