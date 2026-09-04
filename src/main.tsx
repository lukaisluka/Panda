import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Theme } from '@astryxdesign/core/theme';
import { matchaTheme } from '@astryxdesign/theme-matcha/built';
import './index.css';
import App from './App';
import { AstryxSmoke } from './dev/AstryxSmoke';

const root = createRoot(document.getElementById('root')!);

// Dev-only foundation check (#32): open with #/astryx-smoke to verify the
// cascade layers survived a change; the page self-checks and prints PASS/FAIL.
if (import.meta.env.DEV && window.location.hash.replace(/^#\/?/, '') === 'astryx-smoke') {
  root.render(
    <StrictMode>
      <AstryxSmoke />
    </StrictMode>,
  );
} else {
  root.render(
    <StrictMode>
      {/* Built theme: styles come from theme.css, <Theme> only anchors the
          data-astryx-theme scope and owns the color-scheme / light-dark mode. */}
      <Theme theme={matchaTheme}>
        <App />
      </Theme>
    </StrictMode>,
  );
}
