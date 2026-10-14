import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

export const fixtureModel = '@cf/baai/bge-m3';
export type LocalVector = {
  id: string;
  values: number[];
  metadata?: Record<string, string>;
};
type Query = {
  topK: number;
  returnMetadata?: 'all' | 'indexed' | 'none';
  returnValues?: boolean;
  filter?: Record<string, { $in: string[] }>;
};
export type EmbeddingRecordings = {
  model: string;
  dimensions: number;
  vectors: Record<string, { text: string; values: number[] }>;
};
export async function embeddingRecordings() {
  return JSON.parse(
    gunzipSync(await readFile('tests/fixtures/bge-m3.json.gz')).toString(
      'utf8',
    ),
  ) as EmbeddingRecordings;
}
const digest = (text: string) =>
  createHash('sha256').update(text).digest('hex');
function syntheticVector(text: string) {
  const bytes = createHash('sha256').update(text).digest();
  return Array.from(
    { length: 1024 },
    (_, i) => (bytes[i % bytes.length] - 127.5) / 127.5,
  );
}
function cosine(a: number[], b: number[]) {
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    left += a[i] ** 2;
    right += b[i] ** 2;
  }
  return dot / Math.sqrt(left * right);
}
function validQuery(options: Query) {
  const cap =
    options.returnMetadata === 'all' || options.returnValues ? 50 : 100;
  if (options.topK < 1 || options.topK > cap) throw new Error('Invalid topK.');
  if (Buffer.byteLength(JSON.stringify(options.filter ?? {})) > 2048)
    throw new Error('Filter too large.');
}
export class SearchStandIns {
  failEmbedding = false;
  failIndex = false;
  ignoreFilter = false;
  autoAdvance = false;
  embeddingCalls: {
    model: string;
    text: string[];
    truncate_inputs?: boolean;
  }[] = [];
  queries: Query[] = [];
  upserts: LocalVector[][] = [];
  inspections: string[][] = [];
  failInspection = false;
  failDelete = false;
  deletions: string[][] = [];
  d1Trips = 0;
  missing = new Set<string>();
  indexes = new Set(['bucket']);
  private written = new Map<string, LocalVector & { indexed: Set<string> }>();
  private visible = new Map<string, LocalVector & { indexed: Set<string> }>();
  private recordings: EmbeddingRecordings | undefined;
  private strict: boolean;
  constructor(recordings?: EmbeddingRecordings, strict = true) {
    this.recordings = recordings;
    this.strict = strict;
  }
  resetCalls() {
    this.embeddingCalls = [];
    this.queries = [];
    this.upserts = [];
    this.inspections = [];
    this.deletions = [];
    this.d1Trips = 0;
  }
  clear() {
    this.written.clear();
    this.visible.clear();
    this.missing.clear();
    this.resetCalls();
  }
  advance() {
    this.visible = new Map(this.written);
  }
  run(model: string, input: { text: string[]; truncate_inputs?: boolean }) {
    this.embeddingCalls.push({ model, ...input });
    if (this.failEmbedding) throw new Error('Synthetic embedding failure.');
    const data = input.text.map((text) => {
      const entry = this.recordings?.vectors[digest(text)];
      if (entry?.text === text) return entry.values;
      if (!this.strict) return syntheticVector(text);
      this.missing.add(digest(text));
      throw new Error('Missing recorded embedding fixture.');
    });
    return { data, shape: [data.length, 1024] };
  }
  upsert(vectors: LocalVector[]) {
    this.upserts.push(vectors);
    if (this.failIndex) throw new Error('Synthetic vector failure.');
    for (const vector of vectors) {
      if (Buffer.byteLength(vector.id) > 64 || vector.values.length !== 1024)
        throw new Error('Invalid vector.');
      this.written.set(vector.id, {
        ...vector,
        indexed: new Set(this.indexes),
      });
    }
    if (this.autoAdvance) this.advance();
    return { mutationId: 'synthetic-mutation' };
  }
  insert(vectors: LocalVector[]) {
    return this.upsert(vectors.filter((v) => !this.written.has(v.id)));
  }
  getByIds(ids: string[]) {
    this.inspections.push(ids);
    if (this.failInspection || this.failIndex)
      throw new Error('Synthetic inspection failure.');
    return ids.flatMap((id) => {
      const vector = this.visible.get(id);
      return vector
        ? [{ id: vector.id, values: vector.values, metadata: vector.metadata }]
        : [];
    });
  }
  deleteByIds(ids: string[]) {
    this.deletions.push(ids);
    if (this.failDelete || this.failIndex)
      throw new Error('Synthetic delete failure.');
    if (ids.length > 50) throw new Error('Too many removal ids.');
    for (const id of ids) this.written.delete(id);
    if (this.autoAdvance) this.advance();
    return { mutationId: 'synthetic-delete' };
  }
  query(values: number[], options: Query) {
    this.queries.push(options);
    if (this.failIndex) throw new Error('Synthetic vector failure.');
    validQuery(options);
    const matches = [...this.visible.values()]
      .filter(
        (v) =>
          this.ignoreFilter ||
          Object.entries(options.filter ?? {}).every(
            ([key, filter]) =>
              v.indexed.has(key) &&
              filter.$in.includes(v.metadata?.[key] ?? ''),
          ),
      )
      .map((v) => ({
        id: v.id,
        score: cosine(values, v.values),
        metadata: options.returnMetadata === 'all' ? v.metadata : undefined,
      }))
      .sort((a, b) => b.score - a.score || b.id.localeCompare(a.id))
      .slice(0, options.topK);
    return { count: matches.length, matches };
  }
  async fetch(request: Request) {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/d1') {
        this.d1Trips++;
        return new Response('ok');
      }
      const args = (await request.json()) as unknown[];
      if (path === '/run')
        return Response.json(
          this.run(
            args[0] as string,
            args[1] as Parameters<SearchStandIns['run']>[1],
          ),
        );
      if (path === '/query')
        return Response.json(this.query(args[0] as number[], args[1] as Query));
      if (path === '/upsert')
        return Response.json(this.upsert(args[0] as LocalVector[]));
      if (path === '/getByIds')
        return Response.json(this.getByIds(args[0] as string[]));
      if (path === '/deleteByIds')
        return Response.json(this.deleteByIds(args[0] as string[]));
      return new Response('Unknown fixture call.', { status: 404 });
    } catch {
      return new Response('Synthetic search service failure.', { status: 503 });
    }
  }
}
