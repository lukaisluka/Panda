import { describe, expect, it } from 'vitest';
import { usePanda, type SessionEntry } from './store';

describe('replaceSessions', () => {
  it('does not retain sessions from the previous endpoint', () => {
    const previous: SessionEntry = {
      sessionId: 'previous-session', cwd: '/previous', title: null, updatedAt: null,
    };
    const selected: SessionEntry = {
      sessionId: 'selected-session', cwd: '/selected', title: null, updatedAt: null,
    };
    const store = usePanda.getState();

    store.replaceSessions([previous]);
    store.replaceSessions([selected]);

    expect(usePanda.getState().sessions).toEqual([selected]);
  });
});
