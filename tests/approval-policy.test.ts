import { expect, it } from 'vitest';
import { endsAt } from '../apps/web/src/approval-screen';
import {
  type AskFirstMark,
  coveringMark,
} from '../packages/contract/src/approvals.ts';

it.each(['worker', 'web', 'reversed'] as const)(
  '%s ordering chooses the outermost bucket before a secret mark',
  (caller) => {
    const chain: AskFirstMark[] = [
      { kind: 'bucket', path: 'work' },
      { kind: 'bucket', path: 'work/a-b' },
      { kind: 'bucket', path: 'work/a-b/c2' },
      { kind: 'bucket', path: 'work/a-b/c2/d' },
      { kind: 'bucket', path: 'work/a-b/c2/d/e' },
      { kind: 'bucket', path: 'work/a-b/c2/d/e/f' },
      { kind: 'secret', path: 'work/a-b/c2/d/e/f/KEY' },
    ];
    for (let mask = 0; mask < 2 ** chain.length; mask++) {
      const matching = chain.filter((_, index) => mask & (1 << index));
      const marks: AskFirstMark[] = [
        ...matching,
        { kind: 'bucket', path: 'work/a-bb' },
        { kind: 'secret', path: 'work/a-b/c2/d/e/f/OTHER' },
      ];
      marks.sort((a, b) => {
        const left = `${a.kind}:${a.path}`;
        const right = `${b.kind}:${b.path}`;
        return caller === 'worker'
          ? left < right
            ? -1
            : left > right
              ? 1
              : 0
          : a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path);
      });
      if (caller === 'reversed') marks.reverse();
      expect(coveringMark(marks, 'work/a-b/c2/d/e/f/KEY')).toEqual(
        matching[0] ?? null,
      );
      expect(coveringMark(marks, 'work/a-b/c2/d/e/f/')).toEqual(
        matching.find((mark) => mark.kind === 'bucket') ?? null,
      );
      expect(coveringMark(marks, 'me/nook/KEY')).toBeNull();
    }
  },
);

it.each([
  ['once', null],
  ['1h', 3_600_000],
  ['12h', 43_200_000],
] as const)(
  'the %s choice previews its existing remember window',
  (choice, ms) => {
    const now = Date.parse('2026-11-04T10:42:00.000Z');
    expect(endsAt(choice, now)).toBe(ms === null ? null : now + ms);
  },
);
