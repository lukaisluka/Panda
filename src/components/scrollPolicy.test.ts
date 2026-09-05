import { describe, expect, it } from 'vitest';
import {
  DETACH_DISTANCE_PX,
  JANITOR_GAP_PX,
  STICK_INTERVAL_MS,
  USER_SCROLL_WINDOW_MS,
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
