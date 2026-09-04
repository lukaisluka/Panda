import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_THEME_ID,
  isThemeId,
  loadThemeId,
  resolveTheme,
  saveThemeId,
  subscribeTheme,
  THEMES,
  type ThemeStorage,
} from './theme';

/** In-memory localStorage fake — tests run in node, where localStorage is absent. */
class MemoryStorage implements ThemeStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

describe('theme registry', () => {
  it('ships the seven official themes with unique ids', () => {
    expect(THEMES.map((choice) => choice.id)).toEqual([
      'neutral', 'matcha', 'stone', 'butter', 'chocolate', 'gothic', 'y2k',
    ]);
    expect(new Set(THEMES.map((choice) => choice.label)).size).toBe(THEMES.length);
  });

  it('marks gothic as the only dark-only theme', () => {
    expect(THEMES.filter((choice) => choice.darkOnly).map((choice) => choice.id)).toEqual(['gothic']);
  });

  it('defaults to neutral', () => {
    expect(DEFAULT_THEME_ID).toBe('neutral');
    expect(loadThemeId(new MemoryStorage())).toBe('neutral');
  });

  it('resolves every registered id, unknown ids fall back to the default', () => {
    for (const choice of THEMES) {
      expect(resolveTheme(choice.id)).toBe(choice);
    }
    // The cast is the point: callers can only produce this between a load and
    // a render, and resolveTheme must not crash the shell on it.
    expect(resolveTheme('nonexistent' as never).id).toBe(DEFAULT_THEME_ID);
  });
});

describe('theme persistence', () => {
  it('round-trips a choice through storage', () => {
    const storage = new MemoryStorage();
    saveThemeId('chocolate', storage);
    expect(loadThemeId(storage)).toBe('chocolate');
  });

  it('resets unknown stored values loudly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = new MemoryStorage();
    storage.setItem('panda.theme', 'vaporwave');
    expect(loadThemeId(storage)).toBe(DEFAULT_THEME_ID);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('resets unparseable storage loudly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = {
      getItem: () => {
        throw new Error('quota');
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(loadThemeId(broken)).toBe(DEFAULT_THEME_ID);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('notifies subscribers on save and unsubscribes cleanly', () => {
    const storage = new MemoryStorage();
    const seen: string[] = [];
    const unsubscribe = subscribeTheme((themeId) => seen.push(themeId));
    saveThemeId('y2k', storage);
    unsubscribe();
    saveThemeId('matcha', storage);
    expect(seen).toEqual(['y2k']);
  });
});

describe('isThemeId', () => {
  it('accepts registered ids and rejects everything else', () => {
    expect(isThemeId('neutral')).toBe(true);
    expect(isThemeId('Neutral')).toBe(false);
    expect(isThemeId('')).toBe(false);
    expect(isThemeId(null)).toBe(false);
    expect(isThemeId(42)).toBe(false);
  });
});
