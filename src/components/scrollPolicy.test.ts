import { describe, expect, it } from 'vitest';
import {
  DETACH_DISTANCE_PX,
  INTERACTIVE_CONTROL_SELECTOR,
  JANITOR_GAP_PX,
  STICK_INTERVAL_MS,
  USER_SCROLL_WINDOW_MS,
  isUserScrollInput,
  scrollIntent,
  stickDecision,
  userScrollWindowEnd,
} from './scrollPolicy';

describe('scrollIntent (pin/unpin rule, #65)', () => {
  it('re-pins whenever the stream lands within DETACH_DISTANCE_PX of the bottom', () => {
    expect(scrollIntent(0, 1000, 0)).toBe('pin');
    expect(scrollIntent(DETACH_DISTANCE_PX - 1, 1000, 0)).toBe('pin');
    // Even inside the user-scroll window: reaching the bottom re-pins.
    expect(scrollIntent(10, 1000, 2000)).toBe('pin');
  });

  it('unpins only for user-intent scrolls — inside the window AND past the detach distance', () => {
    expect(scrollIntent(DETACH_DISTANCE_PX, 1000, 2000)).toBe('unpin');
    expect(scrollIntent(500, 1000, 2000)).toBe('unpin');
    // Boundary: the window closes exactly at its expiry timestamp.
    expect(scrollIntent(500, 2000, 2000)).toBe('hold');
  });

  it('holds for programmatic scrolls outside the window — recalc restores never detach', () => {
    expect(scrollIntent(500, 1000, 0)).toBe('hold');
    expect(scrollIntent(500, 3000, 2000)).toBe('hold');
  });
});

describe('stickDecision (bottom-stick rate limit, #65)', () => {
  it('sticks immediately once the interval has elapsed (leading edge)', () => {
    expect(stickDecision(1000, 1000 - STICK_INTERVAL_MS, false)).toEqual({ kind: 'now' });
    expect(stickDecision(1000, 0, true)).toEqual({ kind: 'now' });
  });

  it('schedules one trailing stick for arrivals inside the interval, skipping when one is already scheduled', () => {
    const elapsed = STICK_INTERVAL_MS - 10;
    expect(stickDecision(1000, 1000 - elapsed, false)).toEqual({
      kind: 'trailing',
      delayMs: 10,
    });
    expect(stickDecision(1000, 1000 - elapsed, true)).toEqual({ kind: 'skip' });
  });

  it('a fresh stick (elapsed 0) schedules the full interval as the trailing delay', () => {
    expect(stickDecision(1000, 1000, false)).toEqual({ kind: 'trailing', delayMs: STICK_INTERVAL_MS });
  });
});

describe('userScrollWindowEnd', () => {
  it('opens the user-scroll window for USER_SCROLL_WINDOW_MS', () => {
    expect(userScrollWindowEnd(1000)).toBe(1000 + USER_SCROLL_WINDOW_MS);
    expect(USER_SCROLL_WINDOW_MS).toBe(350);
  });
});

describe('policy constants', () => {
  it('keep their audited values (changes here retune the scroll feel)', () => {
    expect(STICK_INTERVAL_MS).toBe(40);
    expect(DETACH_DISTANCE_PX).toBe(48);
    expect(JANITOR_GAP_PX).toBe(8);
  });
});

describe('isUserScrollInput (#210: activation is not scroll intent)', () => {
  it('pointerdown on an interactive control (approve button, form field, link) never opens the window', () => {
    expect(isUserScrollInput({ kind: 'pointerdown', targetInteractive: true })).toBe(false);
  });

  it('pointerdown on plain content or the scroller itself stays scroll intent', () => {
    expect(isUserScrollInput({ kind: 'pointerdown', targetInteractive: false })).toBe(true);
  });

  it('Enter/Space on an interactive control activate it instead of scrolling', () => {
    expect(isUserScrollInput({ kind: 'keydown', key: 'Enter', targetInteractive: true })).toBe(false);
    expect(isUserScrollInput({ kind: 'keydown', key: ' ', targetInteractive: true })).toBe(false);
  });

  it('navigation keys stay scroll intent even on a focused control — arrows/PageDown on a button still scroll the stream', () => {
    expect(isUserScrollInput({ kind: 'keydown', key: 'ArrowUp', targetInteractive: true })).toBe(true);
    expect(isUserScrollInput({ kind: 'keydown', key: 'PageDown', targetInteractive: true })).toBe(true);
    expect(isUserScrollInput({ kind: 'keydown', key: 'Home', targetInteractive: true })).toBe(true);
  });

  it('keys on plain content stay scroll intent, including Space', () => {
    expect(isUserScrollInput({ kind: 'keydown', key: 'ArrowUp', targetInteractive: false })).toBe(true);
    expect(isUserScrollInput({ kind: 'keydown', key: ' ', targetInteractive: false })).toBe(true);
  });

  it('INTERACTIVE_CONTROL_SELECTOR pins the activation surfaces — losing one reopens the unpin bug', () => {
    for (const surface of ['button', 'a', 'input', 'textarea', 'select', 'summary', 'label']) {
      expect(INTERACTIVE_CONTROL_SELECTOR).toContain(surface);
    }
    expect(INTERACTIVE_CONTROL_SELECTOR).toContain('[contenteditable]:not([contenteditable="false"])');
    expect(INTERACTIVE_CONTROL_SELECTOR).toContain('[role="button"]');
  });
});
