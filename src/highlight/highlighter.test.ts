import { describe, expect, it } from 'vitest';
import { highlightCode } from './highlighter';

describe('highlightCode', () => {
  it('highlights a fenced ts block into colored token lines', async () => {
    const lines = await highlightCode('ts', 'const answer: number = 42;');
    expect(lines).not.toBeNull();
    const tokens = lines!.flat();
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.some((t) => t.color)).toBe(true);
  });

  it('maps common fence aliases to shiki language ids', async () => {
    expect(await highlightCode('js', 'const x = 1;')).not.toBeNull();
    expect(await highlightCode('py', 'print(1)')).not.toBeNull();
    expect(await highlightCode('sh', 'echo hi')).not.toBeNull();
  });

  it('returns null for unknown languages and empty code', async () => {
    expect(await highlightCode('nope-lang', 'x = 1')).toBeNull();
    expect(await highlightCode('ts', '')).toBeNull();
  });
});