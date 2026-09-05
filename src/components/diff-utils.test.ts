import { describe, expect, it } from 'vitest';
import { computeRows, intersectSpans, unifiedPatch, withWordSpans } from './diff-utils';

describe('computeRows', () => {
  it('produces a unified row list with dual line numbers', () => {
    const rows = computeRows('a\nb\nc', 'a\nx\nc');
    expect(rows).toEqual([
      { type: 'ctx', oldNo: 1, newNo: 1, text: 'a' },
      { type: 'del', oldNo: 2, newNo: null, text: 'b' },
      { type: 'add', oldNo: null, newNo: 2, text: 'x' },
      { type: 'ctx', oldNo: 3, newNo: 3, text: 'c' },
    ]);
  });

  it('numbers the two sides independently across multiple changes', () => {
    const rows = computeRows('a\nb\nc\nd', 'a\nB\nc\nD');
    expect(rows.map((r) => [r.type, r.oldNo, r.newNo])).toEqual([
      ['ctx', 1, 1],
      ['del', 2, null],
      ['add', null, 2],
      ['ctx', 3, 3],
      ['del', 4, null],
      ['add', null, 4],
    ]);
  });
});

describe('withWordSpans', () => {
  it('pairs adjacent del/add rows and reconstructs both lines from spans', () => {
    const delText = 'return verifySessionA(token, secret);';
    const addText = 'return verifySession(token, secret);';
    const rows = withWordSpans(computeRows(delText, addText));
    const del = rows.find((r) => r.type === 'del')!;
    const add = rows.find((r) => r.type === 'add')!;
    expect(del.words!.map((w) => w.value).join('')).toBe(delText);
    expect(add.words!.map((w) => w.value).join('')).toBe(addText);
    expect(del.words!.some((w) => w.changed)).toBe(true);
    expect(add.words!.some((w) => w.changed)).toBe(true);
    // The shared prefix stays unemphasized on both sides.
    expect(del.words![0]).toEqual({ value: 'return ', changed: false });
    expect(add.words![0]).toEqual({ value: 'return ', changed: false });
  });

  it('pairs runs only up to the shorter side; leftover rows stay unpaired', () => {
    const rows = withWordSpans(computeRows('a\nb', 'c'));
    expect(rows).toHaveLength(3);
    expect(rows[0]!.words).toBeDefined(); // del 'a' paired with add 'c'
    expect(rows[1]!.words).toBeUndefined(); // del 'b' has no counterpart
    expect(rows[2]!.words).toBeDefined();
  });

  it('leaves pure deletions unpaired', () => {
    const rows = withWordSpans(computeRows('a\nb', 'a'));
    expect(rows.find((r) => r.text === 'b')!.words).toBeUndefined();
  });

  it('trims identical leading/trailing lines before pairing a rewritten block', () => {
    const rows: import('./diff-utils').DiffRow[] = [
      { type: 'ctx', oldNo: 1, newNo: 1, text: 'header' },
      { type: 'del', oldNo: 2, newNo: null, text: 'same-pre' },
      { type: 'del', oldNo: 3, newNo: null, text: 'old-core' },
      { type: 'del', oldNo: 4, newNo: null, text: 'same-post' },
      { type: 'add', oldNo: null, newNo: 2, text: 'same-pre' },
      { type: 'add', oldNo: null, newNo: 3, text: 'new-core' },
      { type: 'add', oldNo: null, newNo: 4, text: 'same-post' },
    ];
    const result = withWordSpans(rows);
    expect(result[1]!.words).toBeUndefined(); // del same-pre trimmed from pairing
    expect(result[2]!.words).toBeDefined(); // old-core ↔ new-core
    expect(result[2]!.words!.map((w) => w.value).join('')).toBe('old-core');
    expect(result[2]!.words!.some((w) => w.changed)).toBe(true);
    expect(result[5]!.words).toBeDefined();
    expect(result[5]!.words!.map((w) => w.value).join('')).toBe('new-core');
    expect(result[3]!.words).toBeUndefined(); // del same-post trimmed
    expect(result[4]!.words).toBeUndefined(); // add same-pre trimmed
    expect(result[6]!.words).toBeUndefined(); // add same-post trimmed
  });
});

describe('intersectSpans', () => {
  it('returns token segments unchanged when no word spans exist', () => {
    const out = intersectSpans([{ value: 'ab', color: '#111' }], undefined);
    expect(out).toEqual([{ value: 'ab', color: '#111', changed: false }]);
  });

  it('returns word segments when no tokens exist', () => {
    const out = intersectSpans(null, [{ value: 'ab', changed: true }]);
    expect(out).toEqual([{ value: 'ab', changed: true }]);
  });

  it('splits tokens and words at both segmentations', () => {
    const tokens = [
      { value: 'ab', color: '#111' },
      { value: 'cd', color: '#222' },
    ];
    const words = [
      { value: 'abc', changed: true },
      { value: 'd', changed: false },
    ];
    expect(intersectSpans(tokens, words)).toEqual([
      { value: 'ab', color: '#111', changed: true },
      { value: 'c', color: '#222', changed: true },
      { value: 'd', color: '#222', changed: false },
    ]);
  });

  it('appends remainders defensively when segmentations cover different lengths', () => {
    const tokens = [
      { value: 'ab', color: '#111' },
      { value: 'cd', color: '#222' },
    ];
    const words = [{ value: 'a', changed: true }];
    expect(intersectSpans(tokens, words)).toEqual([
      { value: 'a', color: '#111', changed: true },
      { value: 'b', color: '#111', changed: false },
      { value: 'cd', color: '#222', changed: false },
    ]);
  });

  it('returns an empty list for two empty inputs', () => {
    expect(intersectSpans(null, undefined)).toEqual([]);
  });
});
describe('unifiedPatch', () => {
  it('produces a git-style single hunk with 3 context lines', () => {
    const old = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
    const next = old.map((l, i) => (i === 5 ? 'line 6 CHANGED' : l));
    const patch = unifiedPatch('a.txt', old.join('\n'), next.join('\n'));
    expect(patch).toBe(
      [
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -3,7 +3,7 @@',
        ' line 3',
        ' line 4',
        ' line 5',
        '-line 6',
        '+line 6 CHANGED',
        ' line 7',
        ' line 8',
        ' line 9',
        '',
      ].join('\n'),
    );
  });

  it('splits hunks when the context gap exceeds 2×context', () => {
    const old = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
    const next = old.map((l, i) => (i === 2 || i === 17 ? l + '!' : l));
    const patch = unifiedPatch('a.txt', old.join('\n'), next.join('\n'));
    expect(patch.match(/@@ -\d+,\d+ \+\d+,\d+ @@/g)).toEqual(['@@ -1,6 +1,6 @@', '@@ -15,6 +15,6 @@']);
  });

  it('merges nearby changes into one hunk', () => {
    const old = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const next = ['a', 'B', 'c', 'd', 'e', 'f', 'G', 'h'];
    const patch = unifiedPatch('a.txt', old.join('\n'), next.join('\n'));
    expect(patch.match(/@@ /g)).toHaveLength(1); // 间隔 4 行 ctx ≤ 2×3,合成一个 hunk
    expect(patch).toContain('-b\n+B');
    expect(patch).toContain('-g\n+G');
  });

  it('new file renders as -0,0 with only additions', () => {
    const patch = unifiedPatch('new.ts', '', 'const a = 1;\nconst b = 2;\n');
    expect(patch).toBe(
      [
        '--- a/new.ts',
        '+++ b/new.ts',
        '@@ -0,0 +1,2 @@',
        '+const a = 1;',
        '+const b = 2;',
        '',
      ].join('\n'),
    );
  });

  it('pure deletion renders as +0,0-tail hunk', () => {
    const patch = unifiedPatch('gone.txt', 'x\ny\n', '');
    expect(patch).toBe(
      ['--- a/gone.txt', '+++ b/gone.txt', '@@ -1,2 +0,0 @@', '-x', '-y', ''].join('\n'),
    );
  });

  it('identical texts produce an empty body (headers only)', () => {
    const patch = unifiedPatch('same.txt', 'a\nb', 'a\nb');
    expect(patch).toBe(['--- a/same.txt', '+++ b/same.txt', ''].join('\n'));
  });
});
