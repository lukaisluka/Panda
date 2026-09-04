import { useEffect, useState } from 'react';
import { Theme } from '@astryxdesign/core/theme';
import { matchaTheme } from '@astryxdesign/theme-matcha/built';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { TextInput } from '@astryxdesign/core/TextInput';

/**
 * Dev-only foundation smoke page (#32 Phase 1). Reachable at #astryx-smoke in
 * dev builds only; never shipped. It renders a Button/TextInput/Card trio —
 * the symptom set named in the Astryx migration guide — and asserts that the
 * cascade layers are intact: if a reset or preflight ends up above
 * astryx-base, Button loses its padding and inputs/cards lose borders, "silently
 * and identically on every page".
 */
export function AstryxSmoke() {
  const [result, setResult] = useState<'pending' | 'pass' | 'fail'>('pending');

  useEffect(() => {
    let attempts = 0;
    // Dev-mode CSS arrives as async module injection (astryx.css is ~160KB),
    // so a single frame can race the stylesheet. Poll briefly; steady-state
    // 0px across the window is the real broken-layer signal.
    const timer = window.setInterval(() => {
      const button = document.querySelector<HTMLButtonElement>('[data-smoke="button"] button');
      if (!button || ++attempts > 20) return done(false);
      const pad = getComputedStyle(button).paddingInline;
      if (pad !== '' && pad !== '0px') return done(true);
    }, 100);
    const done = (pass: boolean) => {
      window.clearInterval(timer);
      setResult(pass ? 'pass' : 'fail');
      if (!pass) {
        // Loud on purpose: a broken layer order fails silently in the app.
        console.error(
          '[astryx-smoke] FAIL: Button paddingInline stays "0px" — ' +
            'cascade layer order is broken, see src/index.css header and the Astryx migration guide.',
        );
      }
    };
    return () => window.clearInterval(timer);
  }, []);

  return (
    <Theme theme={matchaTheme} mode="light">
      <div data-smoke="root" style={{ padding: 24, display: 'grid', gap: 16, maxWidth: 420 }}>
        <h1 style={{ fontSize: 16 }}>Astryx cascade smoke</h1>
        <Card>
          <div style={{ display: 'grid', gap: 8 }}>
            <span data-smoke="status">
              {result === 'pending' && 'checking…'}
              {result === 'pass' && 'PASS: paddingInline !== 0 — layers intact'}
              {result === 'fail' && 'FAIL: paddingInline === 0 — see console'}
            </span>
            <div data-smoke="button">
              <Button label="Smoke button" />
            </div>
            <TextInput label="Smoke input" value="" placeholder="smoke" />
          </div>
        </Card>
      </div>
    </Theme>
  );
}
