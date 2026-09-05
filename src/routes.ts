/**
 * Lightweight hash routing (IA refactor phase 1). Panda has exactly two
 * in-app views — the session screen (`#/`) and the settings screen
 * (`#/settings`) — plus dev-only tree-level pages that replace the whole
 * render root (`#/astryx-smoke`, and later `#/demo`); those are parsed by
 * the same function so every hash spelling lives in one place.
 *
 * No router dependency: a `hashchange` listener and this module are the
 * entire mechanism. Unknown hashes fall back to the main view (a stale or
 * mistyped link must never blank the app).
 */
import { useEffect, useState } from 'react';

export type AppRoute = 'main' | 'settings';

export type DevPage = 'astryx-smoke';

/** `''` · `'#'` · `'#/'` → main; `#/settings` (or `#settings`) → settings. */
export function parseHash(hash: string): AppRoute {
  const path = hash.replace(/^#\/?/, '').replace(/\/+$/, '');
  if (path === 'settings') return 'settings';
  return 'main';
}

/** Dev-only tree-level pages (main.tsx renders a different root for these). */
export function parseDevPage(hash: string): DevPage | null {
  const path = hash.replace(/^#\/?/, '').replace(/\/+$/, '');
  if (import.meta.env.DEV && path === 'astryx-smoke') return 'astryx-smoke';
  return null;
}

/** The canonical hash for a route — the single spelling authority. */
export function routeHash(route: AppRoute): string {
  return route === 'main' ? '#/' : `#/${route}`;
}

export function navigate(route: AppRoute): void {
  window.location.hash = routeHash(route);
}

/** The current route, re-resolved on every `hashchange`. Navigation goes
 * through `navigate()` — it flips the hash and the listener re-resolves. */
export function useHashRoute(): AppRoute {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
