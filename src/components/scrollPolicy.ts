/**
 * Pure decision functions of the stream's scroll-following policy (#65).
 * The DOM stays in MessageStream (scrollToIndex, scrollTop writes, timers);
 * these take numbers in and return verdicts, so the pin/unpin and
 * rate-limit rules are unit-testable without a browser.
 */

/**
 * Bottom-stick rate limit: at burst frequency (session/load replays emit
 * hundreds of updates back-to-back) per-event scrolling chokes Virtuoso's
 * internal recalculation machinery and the view freezes behind the content.
 * Sticking at most every 40ms (leading + trailing) keeps normal streaming
 * effectively per-chunk while capping bursts at ~25Hz, which stays healthy.
 */
export const STICK_INTERVAL_MS = 40;

/** Within this gap from the bottom the stream counts as "at the bottom". */
export const DETACH_DISTANCE_PX = 48;

/**
 * How long a wheel/touch/key/pointer input keeps the "user is scrolling"
 * window open: scroll events inside the window may unpin, events outside it
 * (our own sticks, Virtuoso's size-recalc position restores) can only
 * re-pin. Without this, recalc restore steps read as upward scrolls and
 * permanently detach the stream.
 */
export const USER_SCROLL_WINDOW_MS = 350;

/** Residual-gap threshold the settling janitor closes while pinned (px). */
export const JANITOR_GAP_PX = 8;

export type ScrollIntent = 'pin' | 'unpin' | 'hold';

/**
 * One scroll event's verdict: landing within DETACH_DISTANCE_PX of the
 * bottom re-pins; further away, only USER-intent scrolls (inside the
 * user-scroll window) may unpin — programmatic scrolls can only ever
 * re-pin.
 */
export function scrollIntent(gapPx: number, now: number, userScrollUntil: number): ScrollIntent {
  if (gapPx < DETACH_DISTANCE_PX) return 'pin';
  if (now < userScrollUntil) return 'unpin';
  return 'hold';
}

export type StickDecision =
  | { kind: 'now' }
  | { kind: 'trailing'; delayMs: number }
  | { kind: 'skip' };

/**
 * Rate-limited bottom-stick verdict: at most every STICK_INTERVAL_MS,
 * leading + trailing. A trailing timer fires only if the stream is still
 * pinned when it lands (the caller checks via pinnedRef — pinned state is
 * DOM-adjacent, not part of this decision).
 */
export function stickDecision(now: number, lastStickAt: number, trailingScheduled: boolean): StickDecision {
  const elapsed = now - lastStickAt;
  if (elapsed >= STICK_INTERVAL_MS) return { kind: 'now' };
  if (trailingScheduled) return { kind: 'skip' };
  return { kind: 'trailing', delayMs: STICK_INTERVAL_MS - elapsed };
}

/** The expiry timestamp of the user-scroll window opened at `now`. */
export function userScrollWindowEnd(now: number): number {
  return now + USER_SCROLL_WINDOW_MS;
}

/**
 * Interactive controls (#210): pointerdown/keydown landing on one of these
 * is an activation — approve/deny, form fill, link click — never scroll
 * intent. Marking it used to open the user-scroll window as the resolved
 * card collapsed; Virtuoso's height-recalc scroll then read as an upward
 * user scroll, the stream unpinned, and the next permission card could
 * settle out of view. DOM lookup (closest) lives in MessageStream; this
 * selector is the SSOT for what counts as interactive.
 */
export const INTERACTIVE_CONTROL_SELECTOR = [
  'button',
  'a',
  'input',
  'textarea',
  'select',
  'summary',
  'label',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="slider"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="combobox"]',
  '[role="textbox"]',
  '[role="spinbutton"]',
  '[role="searchbox"]',
  '[role="scrollbar"]',
  '[role="treeitem"]',
].join(', ');

/** The structural facts an input event contributes to its intent verdict.
 * `targetInteractive` is the component-side closest() lookup against
 * {@link INTERACTIVE_CONTROL_SELECTOR}. */
export type UserScrollInput = {
  kind: 'pointerdown' | 'keydown';
  /** event.key, for keydown. */
  key?: string;
  targetInteractive: boolean;
};

/** Keys that activate the focused interactive control instead of scrolling
 * it: Space is ' ' in event.key. */
export function isActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ';
}

/** True when this input should open the user-scroll window (#210). A
 * pointerdown on an interactive control is always an activation. For
 * keydown only the activation keys are excused: arrows/PageDown on a
 * focused button still scroll the stream and stay scroll intent. */
export function isUserScrollInput(input: UserScrollInput): boolean {
  if (input.kind === 'pointerdown') return !input.targetInteractive;
  return !(input.targetInteractive && isActivationKey(input.key ?? ''));
}
