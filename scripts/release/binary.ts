import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { stop } from 'esbuild';
import { buildCli } from '../build-cli.ts';

const repository = fileURLToPath(new URL('../..', import.meta.url));

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.status !== 0) throw new Error(`${command} failed.`);
  return result.stdout;
}

export async function packageVersion() {
  const cli = resolve(repository, 'apps/cli/package.json');
  return (JSON.parse(await readFile(cli, 'utf8')) as { version: string })
    .version;
}

// Builds the CLI bundle into a Node single executable at <directory>/nook.
export async function buildExecutable(directory: string) {
  const main = resolve(directory, 'cli.mjs');
  const output = resolve(directory, 'nook');
  const config = resolve(directory, 'sea-config.json');
  try {
    await buildCli(main);
  } finally {
    stop();
  }
  await writeFile(
    config,
    JSON.stringify({
      main,
      output,
      mainFormat: 'module',
      disableExperimentalSEAWarning: true,
    }),
  );
  run(process.execPath, ['--build-sea', config]);
  // Injection invalidates the signature, and macOS kills an unsigned arm64 binary.
  if (process.platform === 'darwin')
    run('codesign', ['--force', '--sign', '-', output]);
  return output;
}

// The executable must run where /usr/bin and /bin hold no Node.
function checkVersion(executable: string, version: string) {
  const bare = ['-i', 'PATH=/usr/bin:/bin'];
  if (spawnSync('env', [...bare, 'sh', '-c', 'command -v node']).status === 0)
    throw new Error(
      'Node is on /usr/bin:/bin, so the check would prove nothing.',
    );
  if (
    run('env', [...bare, executable, 'version']) !==
    `{"version":"${version}"}\n`
  )
    throw new Error('The executable reports a different version.');
}

function target() {
  const platform = process.platform;
  const arch = process.arch;
  if (
    !['linux', 'darwin'].includes(platform) ||
    !['x64', 'arm64'].includes(arch)
  )
    throw new Error('Binaries are built for Linux and macOS on x64 and arm64.');
  return `${platform}-${arch}`;
}

// One ustar entry: an executable owned by root, dated by the release commit.
function tarEntry(name: string, data: Buffer, mtime: number) {
  const header = Buffer.alloc(512);
  const octal = (value: number, length: number) =>
    `${value.toString(8).padStart(length - 1, '0')}\0`;
  const fields: [number, number, string][] = [
    [0, 100, name],
    [100, 8, octal(0o755, 8)],
    [108, 8, octal(0, 8)],
    [116, 8, octal(0, 8)],
    [124, 12, octal(data.length, 12)],
    [136, 12, octal(mtime, 12)],
    [148, 8, ' '.repeat(8)],
    [156, 1, '0'],
    [257, 6, 'ustar\0'],
    [263, 2, '00'],
    [265, 32, 'root'],
    [297, 32, 'root'],
  ];
  for (const [offset, length, value] of fields)
    header.write(value, offset, length, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}

export async function archiveExecutable(
  executable: string,
  version: string,
  output: string,
) {
  const name = `nook-${version}-${target()}.tar.gz`;
  const mtime = Number(
    run('git', ['-C', repository, 'show', '-s', '--format=%ct', 'HEAD']),
  );
  const tar = tarEntry('nook', await readFile(executable), mtime);
  const archive = gzipSync(Buffer.concat([tar, Buffer.alloc(1024)]), {
    level: 9,
  });
  const digest = createHash('sha256').update(archive).digest('hex');
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, name), archive);
  await writeFile(resolve(output, `${name}.sha256`), `${digest}  ${name}\n`);
  return resolve(output, name);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { version: { type: 'string' }, output: { type: 'string' } },
  });
  const version = await packageVersion();
  if (values.version !== undefined && values.version !== version)
    throw new Error(
      'The requested version differs from apps/cli/package.json.',
    );
  if (!values.output)
    throw new Error('Usage: binary.ts [--version X.Y.Z] --output DIR');
  const directory = await mkdtemp(resolve(tmpdir(), 'nook-binary-'));
  try {
    const executable = await buildExecutable(directory);
    checkVersion(executable, version);
    console.log(
      await archiveExecutable(executable, version, resolve(values.output)),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
