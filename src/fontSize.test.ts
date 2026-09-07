import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FONT_SIZE_BOUNDS,
  FONT_SIZE_DEFAULTS,
  applyFontSize,
  isFontSizeValue,
  loadFontSize,
  loadFontSizePair,
  saveFontSize,
  subscribeFontSize,
  type FontSizeStorage,
} from './fontSize';

class MemoryStorage implements FontSizeStorage {
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

describe('fontSize defaults and validation', () => {
  it('returns the ZCode-style defaults for missing values', () => {
    expect(loadFontSize('ui', new MemoryStorage())).toBe(FONT_SIZE_DEFAULTS.ui);
    expect(loadFontSize('code', new MemoryStorage())).toBe(FONT_SIZE_DEFAULTS.code);
  });

  it('accepts integers inside the bounds and nothing else', () => {
    const [uiMin, uiMax] = FONT_SIZE_BOUNDS.ui;
    expect(isFontSizeValue('ui', uiMin)).toBe(true);
    expect(isFontSizeValue('ui', uiMax)).toBe(true);
    expect(isFontSizeValue('ui', uiMin - 1)).toBe(false);
    expect(isFontSizeValue('ui', uiMax + 1)).toBe(false);
    expect(isFontSizeValue('ui', 14.5)).toBe(false);
    expect(isFontSizeValue('ui', '14')).toBe(false);
  });

  it('resets corrupt stored values loudly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = new MemoryStorage();
    storage.setItem('panda.fontSize.ui', 'ninety');
    storage.setItem('panda.fontSize.code', '99');
    expect(loadFontSize('ui', storage)).toBe(FONT_SIZE_DEFAULTS.ui);
    expect(loadFontSize('code', storage)).toBe(FONT_SIZE_DEFAULTS.code);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('warns when the backend read throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken: FontSizeStorage = {
      getItem: () => {
        throw new Error('boom');
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(loadFontSize('ui', broken)).toBe(FONT_SIZE_DEFAULTS.ui);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('fontSize persistence and application', () => {
  it('round-trips a saved pair and notifies subscribers from storage truth', () => {
    const storage = new MemoryStorage();
    const seen: number[] = [];
    const unsubscribe = subscribeFontSize((sizes) => seen.push(sizes.ui));

    saveFontSize('ui', 16, storage);
    saveFontSize('code', 10, storage);

    expect(loadFontSizePair(storage)).toEqual({ ui: 16, code: 10 });
    expect(seen).toEqual([16, 16]);
    unsubscribe();
  });

  it('clamps out-of-range saves instead of persisting them', () => {
    const storage = new MemoryStorage();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const [min, max] = FONT_SIZE_BOUNDS.ui;
    saveFontSize('ui', 99, storage);
    expect(loadFontSize('ui', storage)).toBe(max);
    saveFontSize('ui', 1, storage);
    expect(loadFontSize('ui', storage)).toBe(min);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('survives a throwing backend on save (best-effort persistence)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken: FontSizeStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('boom');
      },
      removeItem: () => {},
    };
    expect(() => saveFontSize('ui', 15, broken)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('applyFontSize', () => {
  it('writes both knob variables onto the document element', () => {
    const setProperty = vi.fn();
    applyFontSize({ ui: 17, code: 11 }, {
      documentElement: { style: { setProperty } },
    } as unknown as Document);
    expect(setProperty).toHaveBeenCalledWith('--panda-size-content', '17px');
    expect(setProperty).toHaveBeenCalledWith('--panda-size-code', '11px');
  });

  it('is a no-op without a DOM (node unit tests)', () => {
    expect(() => applyFontSize({ ui: 14, code: 12 }, undefined)).not.toThrow();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
