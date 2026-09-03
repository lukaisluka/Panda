import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionStorePort, usePanda, type SessionEntry } from './store';

/** Fresh store per test — connection slots are global singletons otherwise. */
beforeEach(() => {
  usePanda.setState({
    mode: 'demo',
    connections: {},
    activeConnectionId: null,
    activeSessionId: null,
  });
});

describe('replaceSessions', () => {
  it('does not retain sessions from the previous endpoint', () => {
    const previous: SessionEntry = {
      sessionId: 'previous-session', cwd: '/previous', title: null, updatedAt: null,
    };
    const selected: SessionEntry = {
      sessionId: 'selected-session', cwd: '/selected', title: null, updatedAt: null,
    };
    const port = connectionStorePort('live');

    usePanda.getState().ensureConnection('live');
    port.replaceSessions([previous]);
    port.replaceSessions([selected]);

    expect(usePanda.getState().connections['live']!.sessions).toEqual([selected]);
  });
});

describe('connection-scoped ports (issue #16)', () => {
  it('isolates documents per session and survives pointer switches', () => {
    usePanda.getState().ensureConnection('live');
    const port = connectionStorePort('live');

    port.adoptSession('s-1', '/a');
    port.update({ sessionUpdate: 'user_message', content: [{ type: 'text', text: 'one' }] });
    port.adoptSession('s-2', '/b');
    port.update({ sessionUpdate: 'user_message', content: [{ type: 'text', text: 'two' }] });

    const docs = usePanda.getState().connections['live']!.docs;
    expect(docs['s-1']!.turns[0]!.blocks[0]).toMatchObject({ kind: 'user_message' });
    // Switching back does not pollute either document.
    port.adoptSession('s-1', '/a');
    port.update({ sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text: 'reply' } });
    expect(docs['s-2']!.turns).toHaveLength(1);
    expect(docs['s-1']!.turns).toHaveLength(1);
    expect(usePanda.getState().activeSessionId).toBe('s-1');
  });

  it('keeps a reconnecting connection transcript (ensureConnection never wipes)', () => {
    usePanda.getState().ensureConnection('live');
    const port = connectionStorePort('live');
    port.adoptSession('s-1', '/a');
    port.update({ sessionUpdate: 'user_message', content: [{ type: 'text', text: 'kept' }] });

    usePanda.getState().ensureConnection('live'); // reconnect of the same slot

    expect(usePanda.getState().connections['live']!.docs['s-1']!.turns).toHaveLength(1);
  });

  it('isolates two connection slots from each other', () => {
    usePanda.getState().ensureConnection('live-a');
    usePanda.getState().ensureConnection('live-b');
    const a = connectionStorePort('live-a');
    const b = connectionStorePort('live-b');

    a.adoptSession('s-1', '/a');
    b.adoptSession('s-1', '/b');
    b.update({ sessionUpdate: 'user_message', content: [{ type: 'text', text: 'B' }] });

    const state = usePanda.getState();
    expect(state.connections['live-a']!.docs['s-1']!.turns).toHaveLength(0);
    expect(state.connections['live-b']!.docs['s-1']!.turns).toHaveLength(1);
    expect(state.activeConnectionId).toBe('live-b');
    expect(state.activeSessionId).toBe('s-1');
  });

  it('drops port writes before a session was adopted, loudly', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    usePanda.getState().ensureConnection('live');
    connectionStorePort('live').update({
      sessionUpdate: 'user_message',
      content: [{ type: 'text', text: 'lost' }],
    });
    expect(usePanda.getState().connections['live']!.docs).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('before adopting a session'));
    warnSpy.mockRestore();
  });

  it('closeConnection removes the slot and clears pointers when active', () => {
    usePanda.getState().ensureConnection('live');
    connectionStorePort('live').adoptSession('s-1', '/a');
    usePanda.getState().closeConnection('live');
    const state = usePanda.getState();
    expect(state.connections['live']).toBeUndefined();
    expect(state.activeConnectionId).toBeNull();
    expect(state.activeSessionId).toBeNull();
  });
});
