import { describe, expect, it } from 'vitest';
import { isImeComposition } from './Composer';

describe('isImeComposition (bug hunt #2: IME Enter must not submit)', () => {
  it('flags the live composition marker', () => {
    expect(isImeComposition({ isComposing: true, keyCode: 13 })).toBe(true);
  });

  it('flags the legacy keyCode 229 marker (engines that never set isComposing)', () => {
    expect(isImeComposition({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isImeComposition({ keyCode: 229 })).toBe(true);
  });

  it('passes through ordinary keys, including plain Enter', () => {
    expect(isImeComposition({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isImeComposition({})).toBe(false);
  });
});
