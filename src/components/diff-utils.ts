import { diffLines, diffWordsWithSpace } from 'diff';

/**
 * Pure diff geometry: line rows, del↔add pairing and word-level segmentation.
 * No React, no highlighting — fully unit-testable.
 */

/** Line-level additions/deletions between two full texts (ACP sends whole files). */
export function diffStats(oldText: string | null, newText: string): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const change of diffLines(oldText ?? '', newText)) {
    const lineCount = change.value.replace(/\n$/, '').split('\n').length;
    if (change.added) additions += lineCount;
    else if (change.removed) deletions += lineCount;
  }
  return { additions, deletions };
}

export type DiffRowType = 'ctx' | 'add' | 'del';

/** Word-level segmentation for paired del/add rows; changed = differing span. */
export type WordSpan = { value: string; changed: boolean };

export type DiffRow = {
  type: DiffRowType;
  oldNo: number | null;
  newNo: number | null;
  text: string;
  /** Present only on rows paired with their counterpart across del/add runs. */
  words?: WordSpan[];
};

/** Unified row list with dual line numbers, in arrival order. */
export function computeRows(oldText: string, newText: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (const change of diffLines(oldText, newText)) {
    const lines = change.value.replace(/\n$/, '').split('\n');
    for (const text of lines) {
      if (change.added) rows.push({ type: 'add', oldNo: null, newNo: newNo++, text });
      else if (change.removed) rows.push({ type: 'del', oldNo: oldNo++, newNo: null, text });
      else rows.push({ type: 'ctx', oldNo: oldNo++, newNo: newNo++, text });
    }
  }
  return rows;
}

/**
 * Pairs adjacent del-runs with their add-runs and fills in word-level spans.
 *
 * Alignment follows the classic trim technique: identical leading/trailing
 * lines of the two runs are peeled off first so pairing happens only on the
 * differing core — otherwise a rewritten block pairs unchanged lines against
 * shifted ones and over-emphasizes everything. Runs of unequal length pair
 * up to the shorter side; leftover rows stay unpaired.
 *
 * Note: `diffWordsWithSpace` splits on whitespace/word boundaries — continuous
 * CJK prose forms one large token, so word-level granularity there is limited
 * (the whole differing run lights up). Code diffs are the primary target.
 */
export function withWordSpans(rows: DiffRow[]): DiffRow[] {
  let i = 0;
  while (i < rows.length) {
    if (rows[i]!.type !== 'del') {
      i++;
      continue;
    }
    let delEnd = i;
    while (delEnd < rows.length && rows[delEnd]!.type === 'del') delEnd++;
    let addEnd = delEnd;
    while (addEnd < rows.length && rows[addEnd]!.type === 'add') addEnd++;
    if (addEnd > delEnd) {
      const dels = rows.slice(i, delEnd);
      const adds = rows.slice(delEnd, addEnd);
      let start = 0;
      while (start < dels.length && start < adds.length && dels[start]!.text === adds[start]!.text) {
        start++;
      }
      let endDel = dels.length;
      let endAdd = adds.length;
      while (endDel > start && endAdd > start && dels[endDel - 1]!.text === adds[endAdd - 1]!.text) {
        endDel--;
        endAdd--;
      }
      const pairs = Math.min(endDel - start, endAdd - start);
      for (let k = 0; k < pairs; k++) {
        applyWordSpans(dels[start + k]!, adds[start + k]!);
      }
    }
    i = addEnd;
  }
  return rows;
}

function applyWordSpans(del: DiffRow, add: DiffRow): void {
  const delWords: WordSpan[] = [];
  const addWords: WordSpan[] = [];
  for (const part of diffWordsWithSpace(del.text, add.text)) {
    if (part.removed) delWords.push({ value: part.value, changed: true });
    else if (part.added) addWords.push({ value: part.value, changed: true });
    else {
      delWords.push({ value: part.value, changed: false });
      addWords.push({ value: part.value, changed: false });
    }
  }
  del.words = delWords;
  add.words = addWords;
}

export type Segment = { value: string; color?: string; changed: boolean };

/**
 * Intersects syntax-token segmentation with word segmentation so a changed
 * word can carry an emphasis background *and* its syntax color. Both inputs
 * cover the same line text; any coverage mismatch (a defensive case) appends
 * the remainder as-is.
 */
export function intersectSpans(
  tokens: readonly { value: string; color?: string }[] | null,
  words: readonly WordSpan[] | undefined,
): Segment[] {
  if (!tokens && !words) return [];
  if (tokens && !words) return tokens.map((t) => ({ value: t.value, color: t.color, changed: false }));
  if (!tokens && words) return words.map((w) => ({ value: w.value, changed: w.changed }));

  const out: Segment[] = [];
  let ti = 0;
  let wi = 0;
  let posT = 0;
  let posW = 0;
  while (ti < tokens!.length && wi < words!.length) {
    const len = Math.min(
      tokens![ti]!.value.length - posT,
      words![wi]!.value.length - posW,
    );
    if (len > 0) {
      out.push({
        value: tokens![ti]!.value.slice(posT, posT + len),
        color: tokens![ti]!.color,
        changed: words![wi]!.changed,
      });
    }
    posT += len;
    posW += len;
    if (posT >= tokens![ti]!.value.length) {
      ti++;
      posT = 0;
    }
    if (posW >= words![wi]!.value.length) {
      wi++;
      posW = 0;
    }
  }
  // Coverage mismatch is a defensive case — append remainders so no text is lost.
  for (let r = ti; r < tokens!.length; r++) {
    const value = tokens![r]!.value.slice(r === ti ? posT : 0);
    if (value) out.push({ value, color: tokens![r]!.color, changed: false });
  }
  for (let r = wi; r < words!.length; r++) {
    const value = words![r]!.value.slice(r === wi ? posW : 0);
    if (value) out.push({ value, changed: words![r]!.changed });
  }
  return out;
}