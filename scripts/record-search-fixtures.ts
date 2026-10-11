import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { recordedTexts } from '../tests/fixtures/search-corpus.ts';

// Run only against the explicitly authorized remote-AI development worker.
// This script is deliberately outside verify, tests, and the deploy workflow.
const endpoint = process.argv[2];
if (endpoint !== 'http://127.0.0.1:4387')
  throw new Error('Use the authorized loopback recording worker on port 4387.');
const path = 'tests/fixtures/bge-m3.json.gz';
const model = '@cf/baai/bge-m3';
const recordings = await readFile(path)
  .then((bytes) => JSON.parse(gunzipSync(bytes).toString('utf8')))
  .catch(() => ({ model, dimensions: 1024, vectors: {} }));
const pending = recordedTexts.filter(
  (text) =>
    !recordings.vectors[createHash('sha256').update(text).digest('hex')],
);
for (let offset = 0; offset < pending.length; offset += 16) {
  const text = pending.slice(offset, offset + 16);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, inputs: { text, truncate_inputs: true } }),
  });
  const result = (await response.json()) as { ok: boolean; data?: number[][] };
  if (!result.ok || result.data?.length !== text.length)
    throw new Error(`Embedding recording batch ${offset / 16 + 1} failed.`);
  for (const [i, input] of text.entries())
    recordings.vectors[createHash('sha256').update(input).digest('hex')] = {
      text: input,
      values: result.data[i],
    };
  await writeFile(path, gzipSync(JSON.stringify(recordings)));
  console.log(
    `Recorded ${Math.min(offset + 16, pending.length)}/${pending.length} missing fixture inputs.`,
  );
}
