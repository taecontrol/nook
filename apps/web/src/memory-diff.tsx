import type { MemoryVersion } from '@nook/contract';
import { cn } from 'cn';
import { type Change, diffLines, diffWordsWithSpace } from 'diff';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';

type Kind = 'same' | 'add' | 'del';
type Segment = { kind: Kind; text: string; id?: number };
type Row = Segment & { segments?: Segment[] };
const kind = (change: Change): Kind =>
  change.added ? 'add' : change.removed ? 'del' : 'same';
function lines(change: Change): Row[] {
  const text = change.value.split('\n');
  if (text.at(-1) === '') text.pop();
  return text.map((text) => ({ kind: kind(change), text }));
}
function highlight(removed: Row[], added: Row[]) {
  for (let i = 0; i < Math.min(removed.length, added.length); i++) {
    const words = diffWordsWithSpace(removed[i].text, added[i].text);
    removed[i].segments = words
      .filter((w) => !w.added)
      .map((w, id) => ({ kind: kind(w), text: w.value, id }));
    added[i].segments = words
      .filter((w) => !w.removed)
      .map((w, id) => ({ kind: kind(w), text: w.value, id }));
  }
}
function rows(before: string, after: string) {
  const changes = diffLines(before, after);
  const result: Row[] = [];
  for (let i = 0; i < changes.length; i++) {
    const current = lines(changes[i]);
    if (changes[i].removed && changes[i + 1]?.added) {
      const added = lines(changes[++i]);
      highlight(current, added);
      result.push(...current, ...added);
    } else result.push(...current);
  }
  return result.map((row, id) => ({ ...row, id }));
}
type Chunk = { rows: Row[]; folded: boolean; id?: number };
function fold(run: Row[], leading: number, trailing: number): Chunk[] {
  if (run.length - leading - trailing < 8)
    return [{ rows: run, folded: false }];
  return [
    { rows: run.slice(0, leading), folded: false },
    { rows: run.slice(leading, run.length - trailing), folded: true },
    { rows: trailing ? run.slice(-trailing) : [], folded: false },
  ];
}
function chunks(rows: Row[]): Chunk[] {
  const result: Chunk[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind !== 'same') {
      result.push({ rows: [rows[i++]], folded: false });
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j].kind === 'same') j++;
    result.push(
      ...fold(rows.slice(i, j), i === 0 ? 0 : 3, j === rows.length ? 0 : 3),
    );
    i = j;
  }
  return result
    .filter((part) => part.rows.length > 0)
    .map((part) => ({ ...part, id: part.rows[0].id }));
}
function Word({ segment }: { segment: Segment }) {
  if (segment.kind === 'add')
    return (
      <ins className="rounded-xs bg-primary/20 no-underline">
        {segment.text}
      </ins>
    );
  if (segment.kind === 'del')
    return (
      <del className="rounded-xs bg-destructive/25 no-underline">
        {segment.text}
      </del>
    );
  return <span>{segment.text}</span>;
}
function DiffRow({ row }: { row: Row }) {
  const markers = { same: ' ', add: '+', del: '−' };
  const prefixes = { same: '', add: 'Added: ', del: 'Removed: ' };
  return (
    <div
      data-diff-row={row.kind}
      className={cn(
        'flex gap-2 px-3',
        row.kind === 'add' && 'bg-primary/8',
        row.kind === 'del' && 'bg-destructive/10',
      )}
    >
      <span
        aria-hidden
        className="w-3 shrink-0 select-none text-center text-muted-foreground"
      >
        {markers[row.kind]}
      </span>
      <span className="sr-only">{prefixes[row.kind]}</span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere">
        {row.segments
          ? row.segments.map((segment) => (
              <Word key={segment.id} segment={segment} />
            ))
          : row.text || ' '}
      </span>
    </div>
  );
}
export function ChangesView({
  before,
  after,
}: {
  before: MemoryVersion;
  after: MemoryVersion;
}) {
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const parts = useMemo(
    () => chunks(rows(before.content, after.content)),
    [before.content, after.content],
  );
  if (before.content === after.content)
    return (
      <p className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
        The content is the same as in version {before.version}.
      </p>
    );
  return (
    <div
      data-memory-diff
      className="overflow-hidden rounded-md border font-mono text-xs leading-6"
    >
      {parts.map((part) =>
        part.folded && !open.has(part.id ?? 0) ? (
          <div className="border-y bg-muted/60 text-center" key={part.id}>
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => setOpen((set) => new Set(set).add(part.id ?? 0))}
            >
              Show {part.rows.length} unchanged lines
            </Button>
          </div>
        ) : (
          part.rows.map((row) => <DiffRow key={row.id} row={row} />)
        ),
      )}
    </div>
  );
}
