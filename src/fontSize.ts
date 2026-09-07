/**
 * Font-size knobs (#171): the type scale collapses to the three-tier
 * contract from DESIGN.md「字体」(content/chrome/micro) driven by ONE ui
 * knob plus an independent code knob — both user-configurable steppers in
 * Settings, ZCode-style (ui 14 / code 12).
 *
 * The variables live in index.css (unlayered, dual-anchored — the px-pin
 * mechanism). This module only persists the knob values and applies them as
 * inline custom properties on <html>: an inline declaration beats every
 * stylesheet layer, so the theme anchors can never win it back. Derived
 * tiers (chrome = ui − 1, micro = ui − 3) are calc()s in CSS — JS touches
 * exactly two variables.
 *
 * Storage follows the per-domain module pattern (theme.ts): localStorage as
 * single source of truth, injectable backend for tests, corrupt values
 * reset loudly, best-effort persistence that never throws.
 */

export type FontSizeKnob = 'ui' | 'code';

/** [min, max] per knob, step 1 — the stepper disables at the bounds. */
export const FONT_SIZE_BOUNDS: Record<FontSizeKnob, readonly [number, number]> = {
  ui: [12, 18],
  code: [10, 16],
};

/** ZCode-style defaults: body 14, code one step denser at 12. */
export const FONT_SIZE_DEFAULTS: Record<FontSizeKnob, number> = {
  ui: 14,
  code: 12,
};

const STORAGE_KEYS: Record<FontSizeKnob, string> = {
  ui: 'panda.fontSize.ui',
  code: 'panda.fontSize.code',
};

/** localStorage-shaped backend; injectable for tests. */
export interface FontSizeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type FontSizePair = Record<FontSizeKnob, number>;

type FontSizeListener = (sizes: FontSizePair) => void;

/** Live subscribers — both steppers re-read from storage on any change so
 * multiple writers can never diverge (storage stays the single truth). */
const listeners = new Set<FontSizeListener>();

export function subscribeFontSize(listener: FontSizeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(storage: FontSizeStorage): void {
  for (const listener of listeners) listener(loadFontSizePair(storage));
}

function defaultStorage(): FontSizeStorage {
  return globalThis.localStorage;
}

export function isFontSizeValue(knob: FontSizeKnob, value: unknown): value is number {
  const [min, max] = FONT_SIZE_BOUNDS[knob];
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** Stored value or the default; corrupt/out-of-range values reset loudly. */
export function loadFontSize(knob: FontSizeKnob, storage: FontSizeStorage = defaultStorage()): number {
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEYS[knob]);
  } catch (err) {
    console.warn(`[panda/fontSize] could not read the ${knob} size`, err);
    return FONT_SIZE_DEFAULTS[knob];
  }
  if (raw === null) return FONT_SIZE_DEFAULTS[knob];
  const parsed = Number(raw);
  if (isFontSizeValue(knob, parsed)) return parsed;
  console.warn(`[panda/fontSize] invalid ${knob} size "${raw}" — using ${FONT_SIZE_DEFAULTS[knob]}`);
  return FONT_SIZE_DEFAULTS[knob];
}

export function loadFontSizePair(storage: FontSizeStorage = defaultStorage()): FontSizePair {
  return { ui: loadFontSize('ui', storage), code: loadFontSize('code', storage) };
}

/** Persists one knob, applies the full pair to <html>, notifies. Out-of-range
 * input is clamped silently — a programmer guard; storage corruption is the
 * loud path (loadFontSize). Failures warn but never throw. */
export function saveFontSize(
  knob: FontSizeKnob,
  value: number,
  storage: FontSizeStorage = defaultStorage(),
): void {
  const [min, max] = FONT_SIZE_BOUNDS[knob];
  const clamped = Math.min(max, Math.max(min, Math.round(value)));
  try {
    storage.setItem(STORAGE_KEYS[knob], String(clamped));
  } catch (err) {
    console.warn(`[panda/fontSize] could not persist the ${knob} size`, err);
  }
  applyFontSize(loadFontSizePair(storage));
  notify(storage);
}

/** Writes the two knob variables onto <html>. Called pre-paint from
 * main.tsx (flash guard) and on every save (live). No-op where there is no
 * DOM (node unit tests). */
export function applyFontSize(
  sizes: FontSizePair,
  doc: Document | undefined = typeof document === 'undefined' ? undefined : document,
): void {
  if (!doc) return;
  doc.documentElement.style.setProperty('--panda-size-content', `${sizes.ui}px`);
  doc.documentElement.style.setProperty('--panda-size-code', `${sizes.code}px`);
}
