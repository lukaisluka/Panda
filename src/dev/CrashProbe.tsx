import type { JSX } from 'react';

/**
 * Dev-only crash probe (`#/crash`, #105): throws during render on purpose —
 * the manual regression path for the ErrorBoundary. Production builds never
 * route here (parseDevPage is DEV-gated), and the probe mounts inside the
 * boundary so the page renders the real crash fallback.
 */
export function CrashProbe(): JSX.Element {
  throw new Error('crash probe (#/crash): intentional render error to exercise the ErrorBoundary');
}
