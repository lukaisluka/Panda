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

describe('transactional session switch (issue #17)', () => {
  it('stages without moving the settled pointers and commits on success', () => {
    usePanda.getState().ensureConnection('live');
    const port = connectionStorePort('live');
    port.adoptSession('s-1', '/a');

    const snapshot = port.stageSession('s-2', '/b');
    expect(snapshot).toMatchObject({ targetSessionId: 's-2', prevSessionId: 's-1', connectionSessionId: 's-1' });
    const mid = usePanda.getState();
    // Staged, not settled: writes route to the target but the pointer stays.
    port.update({ sessionUpdate: 'user_message', content: [{ type: 'text', text: 'replayed' }] });
    expect(mid.connections['live']!.switching).toEqual({ sessionId: 's-2' });
    expect(usePanda.getState().activeSessionId).toBe('s-1');
    expect(usePanda.getState().connections['live']!.connection.sessionId).toBe('s-1');
    expect(usePanda.getState().connections['live']!.docs['s-2']!.turns).toHaveLength(1);

    port.commitStagedSession();
    const settled = usePanda.getState();
    expect(settled.activeSessionId).toBe('s-2');
    expect(settled.connections['live']!.connection.sessionId).toBe('s-2');
    expect(settled.connections['live']!.switching).toBeNull();
  });

  it('rollback restores the revisit document, permission and pointers', () => {
    usePanda.getState().ensureConnection('live');
    const port = connectionStorePort('live');
    port.adoptSession('s-1', '/a');
    // The target was visited before — its cached history must survive a failed switch.
    port.adoptSession('s-2', '/b');
    port.update({ sessionUpdate: 'user_message', content: [{ type: 'text', text: 'cached' }] });
    port.adoptSession('s-1', '/a');
    const cachedDoc = usePanda.getState().connections['live']!.docs['s-2']!;

    const snapshot = port.stageSession('s-2', '/b');
    // The replay reset destroys the cached document and the permission.
    port.resetDocument();
    port.update({ sessionUpdate: 'user_message', content: [{ type: 'text', text: 'partial replay' }] });
    expect(usePanda.getState().connections['live']!.docs['s-2']!.turns).toHaveLength(1);

    port.rollbackStagedSession(snapshot);
    const state = usePanda.getState();
    const slot = state.connections['live']!;
    expect(slot.docs['s-2']).toBe(cachedDoc); // exact pre-switch identity
    expect(slot.connection.sessionId).toBe('s-1');
    expect(slot.switching).toBeNull();
    expect(state.activeSessionId).toBe('s-1'); // pointer never moved
    // The port routes writes back to the previous session.
    port.update({ sessionUpdate: 'user_message', content: [{ type: 'text', text: 'home' }] });
    const after = usePanda.getState().connections['live']!;
    expect(after.docs['s-1']!.turns).toHaveLength(1);
    expect(slot.docs['s-2']!.turns[0]!.blocks[0]).toMatchObject({
      kind: 'user_message',
      content: [{ type: 'text', text: 'cached' }],
    });
  });

  it('rollback removes the placeholder document when the target was never seen', () => {
    usePanda.getState().ensureConnection('live');
    const port = connectionStorePort('live');
    port.adoptSession('s-1', '/a');

    const snapshot = port.stageSession('s-fresh', '/b');
    expect(snapshot.targetDoc).toBeNull();
    port.rollbackStagedSession(snapshot);

    expect(usePanda.getState().connections['live']!.docs['s-fresh']).toBeUndefined();
  });

  it('rollback restores a pending permission cleared by the replay reset', () => {
    usePanda.getState().ensureConnection('live');
    const port = connectionStorePort('live');
    port.adoptSession('s-1', '/a');
    const request = {
      toolCallId: 't-1',
      title: 'Edit file',
      options: [{ id: 'o-1', name: 'Allow once', kind: 'allow_once' as const }],
    };
    port.setPermission(request);

    const snapshot = port.stageSession('s-2', '/b');
    port.resetDocument();
    expect(usePanda.getState().connections['live']!.permission).toBeNull();

    port.rollbackStagedSession(snapshot);
    expect(usePanda.getState().connections['live']!.permission).toEqual(request);
  });

  it('staging keeps the session entry metadata and clears a stale error', () => {
    usePanda.getState().ensureConnection('live');
    const port = connectionStorePort('live');
    port.adoptSession('s-1', '/a');
    port.upsertSession({ sessionId: 's-2', cwd: '/old-cwd', title: '已命名', updatedAt: '2026-01-01T00:00:00Z' });
    port.setConnection({ error: '切换会话失败: 上一次' });

    port.stageSession('s-2', '/new-cwd');
    const slot = usePanda.getState().connections['live']!;
    expect(slot.sessions.find((e) => e.sessionId === 's-2')).toMatchObject({
      cwd: '/new-cwd',
      title: '已命名',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    expect(slot.connection.error).toBeNull();
  });

  it('commitStagedSession without a staged session warns and does nothing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    usePanda.getState().ensureConnection('live');
    const port = connectionStorePort('live');
    usePanda.getState().ensureConnection('live'); // no session ever adopted

    port.commitStagedSession();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('commitStagedSession without a staged session'),
    );
    expect(usePanda.getState().connections['live']!.connection.sessionId).toBeNull();
    expect(usePanda.getState().activeSessionId).toBeNull();
    warnSpy.mockRestore();
  });
});
