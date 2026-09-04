/**
 * Theme registry (#32 Phase 4): all seven official Astryx themes ship in the
 * app, unmodified — selection is a user preference persisted to localStorage
 * per browser, not a build-time brand decision (that was the old Phase 4
 * "fork matcha and customize it" plan, dropped).
 *
 * Joint-debug (2026-09): only EXPOSED_THEME_IDS are user-selectable; the
 * rest stay shipped but hidden (see the array below for the rationale).
 *
 * Built themes carry their CSS in their own `theme.css` (@scope'd under
 * `data-astryx-theme="<id>"`, all seven imported from index.css without
 * clashing); the `DefinedTheme` object passed to <Theme> only anchors the
 * attribute and the color-scheme mode. Switching at runtime is swapping the
 * prop — Panda's own CSS reaches themes exclusively through the alias tokens
 * in index.css, so nothing here touches component styles.
 *
 * The storage backend is injected: the browser passes nothing (localStorage
 * is the default), unit tests pass an in-memory fake — node has no
 * localStorage. Same pattern as profiles.ts.
 */
import type { DefinedTheme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { matchaTheme } from '@astryxdesign/theme-matcha/built';
import { stoneTheme } from '@astryxdesign/theme-stone/built';
import { butterTheme } from '@astryxdesign/theme-butter/built';
import { chocolateTheme } from '@astryxdesign/theme-chocolate/built';
import { gothicTheme } from '@astryxdesign/theme-gothic/built';
import { y2kTheme } from '@astryxdesign/theme-y2k/built';

export type ThemeId =
  | 'neutral' | 'matcha' | 'stone' | 'butter' | 'chocolate' | 'gothic' | 'y2k';

export type ThemeChoice = {
  id: ThemeId;
  /** Sidebar selector label — the theme's own proper name. */
  label: string;
  theme: DefinedTheme;
  /** gothic declares no light tokens at all; it renders dark regardless of
   * OS preference, so <Theme> gets a forced mode for it. */
  darkOnly: boolean;
};

/** Display order = the picker's option order. The full registry: which of
 * these are user-selectable is EXPOSED_THEME_IDS below. */
export const THEMES: readonly ThemeChoice[] = [
  { id: 'neutral', label: 'Neutral', theme: neutralTheme, darkOnly: false },
  { id: 'matcha', label: 'Matcha', theme: matchaTheme, darkOnly: false },
  { id: 'stone', label: 'Stone', theme: stoneTheme, darkOnly: false },
  { id: 'butter', label: 'Butter', theme: butterTheme, darkOnly: false },
  { id: 'chocolate', label: 'Chocolate', theme: chocolateTheme, darkOnly: false },
  { id: 'gothic', label: 'Gothic', theme: gothicTheme, darkOnly: true },
  { id: 'y2k', label: 'Y2K', theme: y2kTheme, darkOnly: false },
];

/** Joint-debug decision (2026-09): maintaining seven themes in parallel cost
 * more than it bought — the picker now exposes a single theme and the rest
 * stay SHIPPED (CSS imports, registry entries, resolveTheme) but hidden.
 * Re-enabling is editing one array. While this list has one entry the
 * sidebar hides the picker entirely (Sidebar.tsx). */
export const EXPOSED_THEME_IDS: readonly ThemeId[] = ['chocolate'];

export const DEFAULT_THEME_ID: ThemeId = 'chocolate';

const THEME_STORAGE_KEY = 'panda.theme';

/** localStorage-shaped backend; injectable for tests. */
export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type ThemeListener = (themeId: ThemeId) => void;

/** Live subscribers — two readers (main.tsx's <Theme> anchor and the sidebar
 * picker) must not diverge; storage stays the single source of truth. */
const listeners = new Set<ThemeListener>();

export function subscribeTheme(listener: ThemeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyTheme(storage: ThemeStorage): void {
  for (const listener of listeners) listener(loadThemeId(storage));
}

function defaultStorage(): ThemeStorage {
  // Browser-only by construction: the UI is the only caller without injection.
  return globalThis.localStorage;
}

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && THEMES.some((choice) => choice.id === value);
}

/** Stored id or the default; corrupt/unknown values reset loudly — a silent
 * fallback to defaults would hide storage drift from the console. A stored
 * id that is valid but currently hidden (EXPOSED_THEME_IDS) also falls back
 * to the default, so pre-hiding choices like 'neutral' land on chocolate
 * instead of resolving a theme the picker can no longer show. */
export function loadThemeId(storage: ThemeStorage = defaultStorage()): ThemeId {
  let raw: string | null;
  try {
    raw = storage.getItem(THEME_STORAGE_KEY);
  } catch (err) {
    console.warn('[panda/theme] could not read theme choice', err);
    return DEFAULT_THEME_ID;
  }
  if (raw === null) return DEFAULT_THEME_ID;
  if (isThemeId(raw)) {
    if (EXPOSED_THEME_IDS.includes(raw)) return raw;
    console.warn(`[panda/theme] theme "${raw}" is currently hidden — using ${DEFAULT_THEME_ID}`);
    return DEFAULT_THEME_ID;
  }
  console.warn(`[panda/theme] unknown theme id "${raw}" — using ${DEFAULT_THEME_ID}`);
  return DEFAULT_THEME_ID;
}

/** Persists the choice and notifies subscribers; failures warn but never
 * throw (best-effort persistence, same contract as profiles). */
export function saveThemeId(themeId: ThemeId, storage: ThemeStorage = defaultStorage()): void {
  try {
    storage.setItem(THEME_STORAGE_KEY, themeId);
  } catch (err) {
    console.warn('[panda/theme] could not persist theme choice', err);
  }
  notifyTheme(storage);
}

/** Registry lookup; every THEMES entry by construction, so callers never
 * null-check. Unknown ids (possible only between loadThemeId and render in
 * the same tick) fall back to the default rather than crashing the shell. */
export function resolveTheme(themeId: ThemeId): ThemeChoice {
  return THEMES.find((choice) => choice.id === themeId)
    ?? THEMES.find((choice) => choice.id === DEFAULT_THEME_ID)!;
}
