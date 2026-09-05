/**
 * Locale state and the translate() core (#91) — same pattern as theme.ts:
 * storage is the single source of truth (injected so node tests can pass an
 * in-memory fake), plus a live-subscriber set so every reader (the React
 * provider AND non-React modules that call t()) re-resolve on switch.
 *
 * Two consumption paths share this module:
 *  - React components: useI18n() (context.tsx) re-renders on switch;
 *  - non-React code (LiveAcpClient error strings, connection lifecycle):
 *    the module-level t() below reads a module-level locale kept in sync by
 *    the subscription. Strings produced that way are fixed at creation time
 *    (an error raised before a switch stays in the old locale) — acceptable
 *    for transient event messages.
 *
 * Default en; a stored zh with a missing translation falls back to the en
 * entry (fail-safe), while a missing KEY warns loudly (programming error).
 */

export type Locale = 'en' | 'zh';

import { messages, type MessageKey } from './messages';

export const LOCALES: readonly Locale[] = ['en', 'zh'];
export const DEFAULT_LOCALE: Locale = 'en';

const LOCALE_STORAGE_KEY = 'panda.locale';

/** localStorage-shaped backend; injectable for tests. */
export interface LocaleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type Vars = Record<string, string | number>;

type LocaleListener = (locale: Locale) => void;

const listeners = new Set<LocaleListener>();

function defaultStorage(): LocaleStorage {
  // Browser-only by construction: the UI is the only caller without injection.
  return globalThis.localStorage;
}

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'zh';
}

/** Stored locale or the default; unreadable/corrupt values warn and reset —
 * a silent fallback would hide storage drift from the console. */
export function loadLocale(storage: LocaleStorage = defaultStorage()): Locale {
  let raw: string | null;
  try {
    raw = storage.getItem(LOCALE_STORAGE_KEY);
  } catch (err) {
    console.warn('[panda/i18n] could not read locale choice', err);
    return DEFAULT_LOCALE;
  }
  if (raw === null) return DEFAULT_LOCALE;
  if (isLocale(raw)) return raw;
  console.warn(`[panda/i18n] unknown locale "${raw}" — using ${DEFAULT_LOCALE}`);
  return DEFAULT_LOCALE;
}

/** Persists the choice and notifies subscribers; failures warn but never
 * throw (best-effort persistence, same contract as theme). */
export function saveLocale(locale: Locale, storage: LocaleStorage = defaultStorage()): void {
  try {
    storage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch (err) {
    console.warn('[panda/i18n] could not persist locale choice', err);
  }
  currentLocale = locale;
  for (const listener of listeners) listener(locale);
}

export function subscribeLocale(listener: LocaleListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** {name} interpolation; an unknown var keeps its placeholder so the miss is
 * visible instead of silently disappearing from the output. */
export function interpolate(template: string, vars: Vars): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match);
}

/** Locale-aware lookup: missing zh falls back to en (fail-safe); a missing
 * key is a programming error — warn and return the key itself. The
 * dictionary is injectable so tests can exercise the fallback path. */
export function translate(
  locale: Locale,
  key: MessageKey,
  vars?: Vars,
  dictionary: Record<string, { en: string; zh?: string }> = messages,
): string {
  const entry = dictionary[key];
  if (!entry) {
    console.warn(`[panda/i18n] missing message key "${key}"`);
    return key;
  }
  const raw = locale === 'zh' ? (entry.zh ?? entry.en) : entry.en;
  return vars ? interpolate(raw, vars) : raw;
}

/** Module-level locale for non-React callers; initialized lazily so node
 * (no localStorage) lands on the default instead of crashing on import. */
let currentLocale: Locale | null = null;

export function getLocale(): Locale {
  if (currentLocale === null) currentLocale = loadLocale();
  return currentLocale;
}

/** Standalone translator for non-React modules; React code goes through
 * useI18n() so switches re-render. */
export function t(key: MessageKey, vars?: Vars): string {
  return translate(getLocale(), key, vars);
}
