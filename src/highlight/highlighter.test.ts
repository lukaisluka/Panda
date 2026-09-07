import { describe, expect, it, vi } from 'vitest';
import { highlightCode, highlightLines, oversizedForHighlight } from './highlighter';

describe('highlightCode', () => {
  it('highlights a fenced ts block into colored token lines', async () => {
    const lines = await highlightCode('ts', 'const answer: number = 42;');
    expect(lines).not.toBeNull();
    const tokens = lines!.flat();
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.some((t) => t.color)).toBe(true);
  });

  it('emits paired light-dark() colors so tokens flip with the color-scheme (#40)', async () => {
    const lines = await highlightCode('ts', 'const answer: number = 42;');
    const colored = lines!.flat().filter((t) => t.color);
    expect(colored.length).toBeGreaterThan(0);
    for (const token of colored) {
      expect(token.color).toMatch(/^light-dark\(#[0-9a-fA-F]+, #[0-9a-fA-F]+\)$/);
    }
    // The pair must actually differ somewhere, otherwise dark mode gained
    // nothing — vitesse-light/dark disagree on at least one token here.
    const distinct = new Set(colored.map((t) => t.color));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('maps common fence aliases to shiki language ids', async () => {
    expect(await highlightCode('js', 'const x = 1;')).not.toBeNull();
    expect(await highlightCode('py', 'print(1)')).not.toBeNull();
    expect(await highlightCode('sh', 'echo hi')).not.toBeNull();
  });

  it('diff path (highlightLines) shares the same light-dark() pipeline', async () => {
    const lines = await highlightLines('a.ts', 'const x = 1;');
    expect(lines).not.toBeNull();
    expect(lines!.flat().some((t) => t.color?.startsWith('light-dark('))).toBe(true);
  });

  it('returns null for unknown languages and empty code', async () => {
    expect(await highlightCode('nope-lang', 'x = 1')).toBeNull();
    expect(await highlightCode('ts', '')).toBeNull();
  });
});

describe('oversized input degrade (#10)', () => {
  it('flags inputs over the line or char threshold, keeps normal code in', () => {
    expect(oversizedForHighlight('const x = 1;')).toBe(false);
    expect(oversizedForHighlight(`${'x\n'.repeat(601)}`)).toBe(true); // 601 lines
    expect(oversizedForHighlight(`${'x'.repeat(30_001)}`)).toBe(true); // one huge line
  });

  it('oversized code renders unhighlighted (null) with one warning per language', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const big = `const x${'= 1;'.repeat(100)};\n`.repeat(120); // well over both thresholds
      expect(await highlightCode('ts', big)).toBeNull();
      expect(await highlightCode('ts', `${big}// again`)).toBeNull(); // second hit stays silent
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain('#10');
    } finally {
      warn.mockRestore();
    }
  });
});