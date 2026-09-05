import { describe, expect, it, vi } from 'vitest';
import {
  interpolate,
  isLocale,
  loadLocale,
  saveLocale,
  subscribeLocale,
  translate,
  getLocale,
  t,
} from './index';

/** In-memory storage fake (node has no localStorage), theme.ts pattern. */
function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
}

describe('loadLocale', () => {
  it('defaults to en when nothing is stored', () => {
    expect(loadLocale(memoryStorage())).toBe('en');
  });

  it('returns a stored zh and keeps en', () => {
    expect(loadLocale(memoryStorage({ 'panda.locale': 'zh' }))).toBe('zh');
    expect(loadLocale(memoryStorage({ 'panda.locale': 'en' }))).toBe('en');
  });

  it('resets loudly on a corrupt value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadLocale(memoryStorage({ 'panda.locale': 'fr' }))).toBe('en');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('survives a throwing storage backend', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = {
      getItem: () => {
        throw new Error('quota');
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(loadLocale(broken)).toBe('en');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('translate', () => {
  it('translates both locales', () => {
    expect(translate('en', 'status.connecting')).toBe('Connecting…');
    expect(translate('zh', 'status.connecting')).toBe('连接中…');
  });

  it('falls back to en when the zh slot is missing', () => {
    const partial = { 'test.only': { en: 'Only en' } };
    expect(translate('zh', 'test.only' as never, undefined, partial)).toBe('Only en');
    expect(translate('en', 'diff.copyPatch')).toBe('Copy patch');
    expect(translate('zh', 'diff.copyPatch')).toBe('复制补丁');
  });

  it('interpolates {name} vars', () => {
    expect(translate('zh', 'side.attentionTooltip', { reasons: '未读完成' })).toBe(
      '需要关注:未读完成',
    );
    expect(translate('en', 'status.authenticatedVia', { name: 'token' })).toBe(
      'Authenticated via “token”',
    );
  });

  it('warns and returns the key itself for a missing key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const key = 'no.such.key' as Parameters<typeof translate>[1];
    expect(translate('en', key)).toBe('no.such.key');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('interpolate', () => {
  it('fills every occurrence and stringifies numbers', () => {
    expect(interpolate('{n} + {n} = {r}', { n: 1, r: 2 })).toBe('1 + 1 = 2');
  });

  it('keeps unknown placeholders visible instead of dropping them', () => {
    expect(interpolate('{a} {b}', { a: 'x' })).toBe('x {b}');
  });
});

describe('locale switching', () => {
  it('persists, notifies subscribers, and moves the module-level t()', () => {
    const storage = memoryStorage();
    const seen: string[] = [];
    const unsubscribe = subscribeLocale((locale) => seen.push(locale));
    saveLocale('zh', storage);
    expect(storage.getItem('panda.locale')).toBe('zh');
    expect(seen).toEqual(['zh']);
    expect(getLocale()).toBe('zh');
    expect(t('perm.allowAlways')).toBe('始终允许');
    saveLocale('en', storage);
    expect(t('perm.allowAlways')).toBe('Always allow');
    unsubscribe();
  });

  it('keeps best-effort semantics when persistence throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = {
      ...memoryStorage(),
      setItem: () => {
        throw new Error('quota');
      },
    };
    const seen: string[] = [];
    const unsubscribe = subscribeLocale((locale) => seen.push(locale));
    expect(() => saveLocale('zh', broken)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['zh']); // in-memory state still moved
    unsubscribe();
    warn.mockRestore();
  });
});

describe('isLocale', () => {
  it('accepts only the two known locales', () => {
    expect(isLocale('en')).toBe(true);
    expect(isLocale('zh')).toBe(true);
    expect(isLocale('EN')).toBe(false);
    expect(isLocale(7)).toBe(false);
  });
});
