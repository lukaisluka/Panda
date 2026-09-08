import { describe, expect, it } from 'vitest';
import { imageHintState, isImeComposition } from './Composer';

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

describe('imageHintState (#214: no agent, no capability claims)', () => {
  it('renders no hint while no agent is connected or connecting', () => {
    expect(imageHintState(undefined)).toBeNull();
  });

  it('names a negotiated agent that lacks image input', () => {
    expect(imageHintState(false)).toBe('unavailable');
  });

  it('shows the paste-or-attach hint once image input is negotiated', () => {
    expect(imageHintState(true)).toBe('available');
  });
});
