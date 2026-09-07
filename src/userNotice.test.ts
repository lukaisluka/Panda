import { describe, expect, it, vi } from 'vitest';
import { notifyUser, subscribeUserNotices } from './userNotice';

describe('userNotice bus (#160)', () => {
  it('delivers notices to subscribers with a unique id', () => {
    const seen: string[] = [];
    const off = subscribeUserNotices((n) => seen.push(`${n.kind}:${n.message}:${n.id}`));
    notifyUser('error', 'switch rejected');
    notifyUser('info', 'list refreshed');
    off();
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/^error:switch rejected:\d+$/);
    expect(Number(seen[1]!.split(':').pop())).toBeGreaterThan(Number(seen[0]!.split(':').pop()!));
  });

  it('stops delivering after unsubscribe', () => {
    const listener = vi.fn();
    const off = subscribeUserNotices(listener);
    off();
    notifyUser('error', 'late');
    expect(listener).not.toHaveBeenCalled();
  });

  it('is a no-op with no subscribers (unit-test default), never throws', () => {
    expect(() => notifyUser('error', 'nobody listens')).not.toThrow();
  });
});
