import { afterEach, describe, expect, it } from 'vitest';
import { parseDevPage, parseHash, routeHash } from './routes';

describe('parseHash', () => {
  it.each([
    ['', 'main'],
    ['#', 'main'],
    ['#/', 'main'],
    ['#//', 'main'],
    ['#/settings', 'settings'],
    ['#settings', 'settings'],
    ['#/settings/', 'settings'],
    ['#/settings//', 'settings'],
    // Unknown or stale links fall back to main — never a blank app.
    ['#/nope', 'main'],
    ['#/settings/extra', 'main'],
  ])('parses %j as %s', (hash, route) => {
    expect(parseHash(hash)).toBe(route);
  });
});

describe('demo route gating (phase 2: production has no replay entry)', () => {
  const originalDev = import.meta.env.DEV;
  afterEach(() => {
    import.meta.env.DEV = originalDev;
  });

  it('parses #/demo in dev builds', () => {
    import.meta.env.DEV = true;
    expect(parseHash('#/demo')).toBe('demo');
    expect(parseHash('#demo/')).toBe('demo');
  });

  it('falls back to main outside dev builds', () => {
    import.meta.env.DEV = false;
    expect(parseHash('#/demo')).toBe('main');
  });
});

describe('parseDevPage', () => {
  it('recognizes the dev-only smoke page', () => {
    expect(parseDevPage('#/astryx-smoke')).toBe('astryx-smoke');
    expect(parseDevPage('#astryx-smoke/')).toBe('astryx-smoke');
    expect(parseDevPage('#/settings')).toBe(null);
    expect(parseDevPage('')).toBe(null);
  });
});

describe('routeHash / navigate round-trip', () => {
  it('produces canonical hashes parseHash round-trips', () => {
    expect(routeHash('main')).toBe('#/');
    expect(routeHash('settings')).toBe('#/settings');
    expect(routeHash('demo')).toBe('#/demo');
    expect(parseHash(routeHash('main'))).toBe('main');
    expect(parseHash(routeHash('settings'))).toBe('settings');
    expect(import.meta.env.DEV && parseHash(routeHash('demo'))).toBe('demo');
  });
});
