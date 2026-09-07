import type { Vars } from './i18n';
import type { MessageKey } from './i18n/messages';

/**
 * Sidebar session-row timestamps (#175): "3 min ago" phrasing for the last
 * activity stamped on a session (agent reported or host stamped — see
 * SessionEntry.updatedAt). The label is computed at render and intentionally
 * NOT refreshed on a timer — any store churn re-renders the sidebar, and a
 * minute-stale label costs less than a wake-up source; the exact absolute
 * time rides along as the row's tooltip.
 */

/** Minimal translator so tests can stub without the React provider. */
export type RelativeTimeT = (key: MessageKey, vars?: Vars) => string;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Formats an ISO timestamp as a coarse relative label: just now → N min →
 * N h → N d → absolute date (browser locale, beyond a week coarse units lie).
 * Future timestamps clamp to "just now" (a slightly-ahead agent clock must
 * not render "-2 min ago"); null and unparsable input render nothing.
 */
export function formatRelativeTime(iso: string | null, t: RelativeTimeT, now = Date.now()): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE) return t('side.time.justNow');
  if (elapsed < HOUR) return t('side.time.minutesAgo', { n: Math.floor(elapsed / MINUTE) });
  if (elapsed < DAY) return t('side.time.hoursAgo', { n: Math.floor(elapsed / HOUR) });
  if (elapsed < 7 * DAY) return t('side.time.daysAgo', { n: Math.floor(elapsed / DAY) });
  return new Date(at).toLocaleDateString();
}
