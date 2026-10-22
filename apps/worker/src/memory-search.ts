import type { OwnerMemorySearchResult } from '@nook/contract';

export function keywordExpression(query: string) {
  return query
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 16)
    .map((token) => `"${token.replaceAll('"', '""')}"*`)
    .join(' ');
}
type Snippet = { snippet: string; highlights: [number, number][] };
function codePointBoundary(text: string, index: number) {
  return (text.codePointAt(index - 1) ?? 0) > 0xffff ? index - 1 : index;
}
function clipped(snippet: string, highlights: [number, number][]): Snippet {
  const first = highlights[0]?.[0] ?? 0;
  const start = codePointBoundary(snippet, first > 70 ? first - 40 : 0);
  const prefix = start ? '…' : '';
  const end = codePointBoundary(snippet, start + 238);
  return {
    snippet: `${prefix}${snippet.slice(start, end)}${snippet.length > end ? '…' : ''}`,
    highlights: highlights
      .filter(([s, e]) => e > start && s < end)
      .map(([s, e]) => [
        Math.max(s, start) - start + prefix.length,
        Math.min(e, end) - start + prefix.length,
      ]),
  };
}
export function openingSnippet(content: string): Snippet {
  return clipped(
    content
      .replace(/^#+\s*/, '')
      .replace(/\s+/g, ' ')
      .trim(),
    [],
  );
}
export function keywordSnippet(marked: string, delimiter: string): Snippet {
  const highlights: [number, number][] = [];
  let snippet = '';
  const chunks = marked.split(delimiter);
  for (const [i, chunk] of chunks.entries()) {
    const start = snippet.length;
    snippet += chunk.replace(/\s+/g, ' ');
    if (i % 2) highlights.push([start, snippet.length]);
  }
  return clipped(snippet, highlights);
}
type Candidate<Result> = Result & { score: number };
export function rankedSearch<Result extends OwnerMemorySearchResult>(
  keyword: readonly Result[],
  meaning: readonly { result: Result; rank: number }[],
  limit: number,
) {
  const candidates = new Map<string, Candidate<Result>>();
  for (const [i, result] of keyword.entries())
    candidates.set(result.id, { ...result, score: 1 / (60 + i + 1) });
  for (const { result, rank } of meaning) {
    const previous = candidates.get(result.id);
    candidates.set(
      result.id,
      previous
        ? {
            ...previous,
            match: 'both',
            score: previous.score + 1 / (60 + rank),
          }
        : { ...result, score: 1 / (60 + rank) },
    );
  }
  return [...candidates.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.createdAt.localeCompare(a.createdAt) ||
        b.id.localeCompare(a.id),
    )
    .slice(0, limit)
    .map(({ score: _, ...result }) => result);
}
