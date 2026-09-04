import { describe, expect, it } from 'vitest';
import { highlightCode, highlightLines } from './highlighter';

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