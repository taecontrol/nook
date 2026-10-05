import { execute } from './commands.ts';

// Catch defects at the process boundary without printing a cause or process argv.
try {
  process.exitCode = await execute(process.argv.slice(2));
} catch {
  process.stderr.write('Nook could not complete the command. Try again.\n');
  process.exitCode = 1;
}
