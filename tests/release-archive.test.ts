import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { archiveExecutable } from '../scripts/release/binary.ts';

it('a release archive holds only the executable, byte for byte and still executable, beside its sha256sum checksum', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'nook-release-archive-'));
  try {
    const executable = resolve(directory, 'built');
    // Not a multiple of 512 bytes, so the tar padding matters.
    const content = randomBytes(70_001);
    await writeFile(executable, content, { mode: 0o755 });
    const archive = await archiveExecutable(
      executable,
      '1.2.3',
      resolve(directory, 'assets'),
    );
    const name = `nook-1.2.3-${process.platform}-${process.arch}.tar.gz`;
    expect(basename(archive)).toBe(name);
    const digest = createHash('sha256')
      .update(await readFile(archive))
      .digest('hex');
    expect(await readFile(`${archive}.sha256`, 'utf8')).toBe(
      `${digest}  ${name}\n`,
    );
    expect(
      spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' }),
    ).toMatchObject({ status: 0, stdout: 'nook\n' });
    const extracted = resolve(directory, 'extracted');
    await mkdir(extracted);
    expect(spawnSync('tar', ['-xzf', archive, '-C', extracted]).status).toBe(0);
    const nook = resolve(extracted, 'nook');
    expect((await readFile(nook)).equals(content)).toBe(true);
    expect((await stat(nook)).mode & 0o111).toBe(0o111);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
