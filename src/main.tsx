import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Theme } from '@astryxdesign/core/theme';
import './index.css';
import App from './App';
import { AstryxSmoke } from './dev/AstryxSmoke';
import { loadThemeId, resolveTheme, subscribeTheme } from './theme';
import { I18nProvider } from './i18n/context';
import { parseDevPage } from './routes';

const root = createRoot(document.getElementById('root')!);

/** Runtime theme switch (#32 Phase 4): storage is the single source of truth
 * (same contract as profiles.ts) — the sidebar picker saves, this anchor and
 * the picker both re-render off the subscription. Built theme CSS ships in
 * index.css for all seven; <Theme> only anchors data-astryx-theme and the
 * color-scheme mode (gothic has no light tokens — forced dark). */
function ThemeRoot() {
  const [themeId, setThemeId] = useState(loadThemeId);
  useEffect(() => subscribeTheme(setThemeId), []);
  const choice = resolveTheme(themeId);
  return (
    <Theme theme={choice.theme} mode={choice.darkOnly ? 'dark' : 'system'}>
      <I18nProvider>
        <App />
      </I18nProvider>
    </Theme>
  );
}

// Dev-only tree-level pages: parseDevPage (routes.ts) owns every hash
// spelling — a tree-level page replaces the whole render root, while
// in-app views (#/, #/settings) route inside App.
if (parseDevPage(window.location.hash) === 'astryx-smoke') {
  root.render(
    <StrictMode>
      <AstryxSmoke />
    </StrictMode>,
  );
} else {
  root.render(
    <StrictMode>
      <ThemeRoot />
    </StrictMode>,
  );
}
