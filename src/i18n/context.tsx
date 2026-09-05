/**
 * React binding for the i18n module (#91): a context provider that mirrors
 * the locale from storage (loadLocale on mount, subscribeLocale for live
 * switches) and hands components a scoped t(). Everything below App can call
 * useI18n() instead of threading locale props; document lang follows the
 * choice for a11y.
 *
 * Switching goes through saveLocale (never local state) so non-React t()
 * callers and this provider move together — storage stays the single source
 * of truth, same as theme.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  loadLocale,
  saveLocale,
  subscribeLocale,
  translate,
  type Locale,
  type Vars,
} from './index';
import type { MessageKey } from './messages';

export type Translate = (key: MessageKey, vars?: Vars) => string;

export type I18nValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translate;
};

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(loadLocale);

  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  }, [locale]);

  useEffect(
    () => subscribeLocale(setLocaleState),
    [],
  );

  const setLocale = useCallback((next: Locale) => {
    saveLocale(next);
  }, []);

  const value = useMemo<I18nValue>(
    () => ({ locale, setLocale, t: (key, vars) => translate(locale, key, vars) }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside <I18nProvider>');
  return value;
}
