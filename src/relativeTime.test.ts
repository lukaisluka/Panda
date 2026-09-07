import { describe, expect, it } from 'vitest';
import { formatRelativeTime, type RelativeTimeT } from './relativeTime';

/** Records the call so assertions can check the chosen unit and count. */
const recordingT =
  (...capture: string[]):
    RelativeTimeT =>
  (key, vars) => {
    capture[0] = vars ? `${key}(${vars.n})` : key;
    return capture[0];
  };

const NOW = Date.parse('2026-09-07T12:00:00Z');

describe('formatRelativeTime (#175)', () => {
  it('renders coarse units at each boundary', () => {
    expect(formatRelativeTime(new Date(NOW - 30_000).toISOString(), recordingT(), NOW)).toBe('side.time.justNow');
    expect(formatRelativeTime(new Date(NOW - 5 * 60_000).toISOString(), recordingT(), NOW)).toBe('side.time.minutesAgo(5)');
    expect(formatRelativeTime(new Date(NOW - 3 * 3_600_000).toISOString(), recordingT(), NOW)).toBe('side.time.hoursAgo(3)');
    expect(formatRelativeTime(new Date(NOW - 2 * 86_400_000).toISOString(), recordingT(), NOW)).toBe('side.time.daysAgo(2)');
  });

  it('beyond a week falls back to the locale absolute date', () => {
    const at = new Date(NOW - 30 * 86_400_000);
    expect(formatRelativeTime(at.toISOString(), recordingT(), NOW)).toBe(at.toLocaleDateString());
  });

  it('a slightly-ahead agent clock clamps to just now, never a negative label', () => {
    expect(formatRelativeTime(new Date(NOW + 5_000).toISOString(), recordingT(), NOW)).toBe('side.time.justNow');
  });

  it('null and unparsable input render nothing', () => {
    expect(formatRelativeTime(null, recordingT(), NOW)).toBeNull();
    expect(formatRelativeTime('not-a-timestamp', recordingT(), NOW)).toBeNull();
  });
});
