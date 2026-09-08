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
import { InternationalizationProvider } from '@astryxdesign/core/i18n';
import zhCN from '@astryxdesign/core/locales/zh-CN.json';
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

/** Astryx's BCP 47 tag per Panda locale. zh maps to the shipped zh-CN
 * catalog (missing keys resolve back to en inside astryx). */
const ASTRYX_LOCALE: Record<Locale, string> = { en: 'en', zh: 'zh-CN' };

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

  return (
    <I18nContext.Provider value={value}>
      {/* Astryx components' built-in copy (alert-dialog buttons, dialog
       * close labels, screen-reader names…) follows the same locale as
       * Panda's dictionary — without this bridge they render from the
       * bundled en catalog forever (#213). Inside this provider, a locale
       * switch propagates to both dictionaries at once. */}
      <InternationalizationProvider locale={ASTRYX_LOCALE[locale]} messages={{ 'zh-CN': zhCN }}>
        {children}
      </InternationalizationProvider>
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside <I18nProvider>');
  return value;
}
