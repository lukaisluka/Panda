import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEMO_CONNECTION_ID,
  connectionStorePort,
  orderedConnectionIds,
  usePanda,
  type SessionEntry,
} from './store';
import { connectionLifecycle } from './projector/connectionLifecycle';

/** Fresh store per test — connection slots are global singletons otherwise. */
beforeEach(() => {
  usePanda.setState({
    mode: 'live',
    connections: {},
    activeConnectionId: null,
    activeSessionId: null,
    selectionGeneration: 0,
  });
});

describe('initial mode', () => {
  it('is live — the demo replay is a dev-only #/demo route, not the default', () => {
    expect(usePanda.getInitialState().mode).toBe('live');
  });
});

describe('seedConnection (phase 3: offline agent sections)', () => {
  it('creates the slot without claiming an existing foreground', () => {
    usePanda.getState().ensureConnection('foreground');
    usePanda.getState().seedConnection('seeded');
    expect(usePanda.getState().connections['seeded']).toBeDefined();
    expect(usePanda.getState().activeConnectionId).toBe('foreground');
  });

  it('may take an empty foreground — the sidebar seeds before anything is active', () => {
    usePanda.getState().seedConnection('first');
    expect(usePanda.getState().activeConnectionId).toBe('first');
  });

  it('never rewrites an existing slot (documents survive re-seeding)', () => {
    usePanda.getState().seedConnection('p');
    const port = connectionStorePort('p');
    port.adoptSession('s-1', '/a');
    port.update({ sessionUpdate: 'user_message', content: [{ type: 'text', text: 'kept' }] });

    usePanda.getState().seedConnection('p');

    const slot = usePanda.getState().connections['p']!;
    expect(slot.docs['s-1']!.turns[0]!.blocks[0]).toMatchObject({ kind: 'user_message' });
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
    // The marker carries the minted token (issue #19) — a settle may only
    // clear the marker its own transaction set.
    expect(usePanda.getState().connections['live']!.switching).toMatchObject({
      sessionId: 's-2',
      selectionToken: snapshot.selectionToken,
    });
    // Staged, not settled: writes route to the target but the pointer stays.
    port.update({ sessionUpdate: 'user_message', content: [{ type: 'text', text: 'replayed' }] });
    expect(usePanda.getState().activeSessionId).toBe('s-1');
    expect(usePanda.getState().connections['live']!.connection.sessionId).toBe('s-1');
    expect(usePanda.getState().connections['live']!.docs['s-2']!.turns).toHaveLength(1);

    port.commitStagedSession(snapshot);
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

  it('rollback restores pending permissions cleared by the replay reset', () => {
    usePanda.getState().ensureConnection('live');
    const port = connectionStorePort('live');
    port.adoptSession('s-1', '/a');
    const request = {
      toolCallId: 't-1',
      title: 'Edit file',
      options: [{ id: 'o-1', name: 'Allow once', kind: 'allow_once' as const }],
    };
    // Permissions live in the document (issue #18): the target of a revisit
    // switch carries a pending permission that the replay reset destroys.
    port.adoptSession('s-2', '/b');
    port.update({ sessionUpdate: 'user_message', content: [{ type: 'text', text: 'work' }] });
    port.update({ sessionUpdate: 'permission_requested', request });
    port.adoptSession('s-1', '/a');

    const snapshot = port.stageSession('s-2', '/b');
    port.resetDocument();
    expect(usePanda.getState().connections['live']!.docs['s-2']!.permissions).toEqual({});

    port.rollbackStagedSession(snapshot);
    expect(usePanda.getState().connections['live']!.docs['s-2']!.permissions['t-1']).toMatchObject({
      status: 'pending',
      request,
    });
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

  it('commitStagedSession without a staged snapshot warns, clears switching, never deadlocks', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    usePanda.getState().ensureConnection('live');
    const port = connectionStorePort('live'); // no session ever adopted

    port.commitStagedSession(null);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('commitStagedSession without a staged snapshot'),
    );
    expect(usePanda.getState().connections['live']!.connection.sessionId).toBeNull();
    expect(usePanda.getState().activeSessionId).toBeNull();
    warnSpy.mockRestore();
  });

  it('commitStagedSession clears switching when the staged session was dropped mid-switch', () => {
    // The delete-mid-switch path: removeSession nulls the port's routing, the
    // pending load later succeeds — commit must not leave a stale marker.
    usePanda.getState().ensureConnection('live');
    const port = connectionStorePort('live');
    port.adoptSession('s-1', '/a');
    const snapshot = port.stageSession('s-2', '/b');
    port.removeSession('s-2');

    port.commitStagedSession(snapshot);

    expect(usePanda.getState().connections['live']!.switching).toBeNull();
    // The pointer stays on the surviving session; the UI never locks busy.
    expect(usePanda.getState().connections['live']!.connection.sessionId).toBe('s-1');
  });
});

describe('selection generation (issue #19)', () => {
  it('latest-wins: a late commit for a superseded switch never moves the pointer', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    usePanda.getState().ensureConnection('live');
    const port = connectionStorePort('live');
    port.adoptSession('s-1', '/a');

    // Two overlapping switch attempts (the client blocks these today; the
    // store must survive them anyway — drivers can drift, #21 lifts the
    // block). A's replay history routes into s-A's own document.
    const switchA = port.stageSession('s-A', '/a');
    port.update({ sessionUpdate: 'user_message', content: [{ type: 'text', text: 'A history' }] });
    const switchB = port.stageSession('s-B', '/b');
    port.update({ sessionUpdate: 'user_message', content: [{ type: 'text', text: 'B history' }] });

    // A's load completes late: latest-wins — no settled pointer moves, and
    // B's marker survives A's stale commit.
    port.commitStagedSession(switchA);
    let state = usePanda.getState();
    expect(state.activeSessionId).toBe('s-1');
    expect(state.connections['live']!.connection.sessionId).toBe('s-1');
    expect(state.connections['live']!.switching).toMatchObject({ sessionId: 's-B' });
    // A's history stays filed under its own session document.
    expect(state.connections['live']!.docs['s-A']!.turns).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('superseded'));

    port.commitStagedSession(switchB);
    state = usePanda.getState();
    expect(state.activeSessionId).toBe('s-B');
    expect(state.connections['live']!.switching).toBeNull();
    warnSpy.mockRestore();
  });

  it('a superseded rollback restores documents but not the newer era\'s settled routing', () => {
    usePanda.getState().ensureConnection('live');
    const port = connectionStorePort('live');
    port.adoptSession('s-1', '/a');
    const switchA = port.stageSession('s-A', '/a');
    port.update({ sessionUpdate: 'user_message', content: [{ type: 'text', text: 'A partial replay' }] });
    const switchB = port.stageSession('s-B', '/b');
    port.commitStagedSession(switchB);

    // A's transaction dies late: its document restore is still correct
    // (era-scoped), but the settled routing now belongs to B.
    port.rollbackStagedSession(switchA);
    const state = usePanda.getState();
    expect(state.connections['live']!.connection.sessionId).toBe('s-B');
    expect(state.activeSessionId).toBe('s-B');
    // A never had a pre-switch document — the placeholder the stage created
    // (and its partial replay) is removed, not resurrected as state.
    expect(state.connections['live']!.docs['s-A']).toBeUndefined();
  });

  it('a close invalidates in-flight selections — a late commit moves nothing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    usePanda.getState().ensureConnection('live');
    const port = connectionStorePort('live');
    port.adoptSession('s-1', '/a');
    const snapshot = port.stageSession('s-2', '/b');

    port.invalidateSelections(); // what the driver calls on disconnect
    port.commitStagedSession(snapshot);

    const state = usePanda.getState();
    expect(state.activeSessionId).toBe('s-1');
    expect(state.connections['live']!.connection.sessionId).toBe('s-1');
    expect(state.connections['live']!.switching).toBeNull();
    warnSpy.mockRestore();
  });

  it('an unrelated delete does not invalidate an in-flight switch', () => {
    usePanda.getState().ensureConnection('live');
    const port = connectionStorePort('live');
    port.adoptSession('s-1', '/a');
    const snapshot = port.stageSession('s-2', '/b');

    port.removeSession('s-unrelated'); // deleting some other session
    port.commitStagedSession(snapshot);

    expect(usePanda.getState().activeSessionId).toBe('s-2'); // the switch settles
  });

  it('deleting the SETTLED session invalidates an in-flight switch (late commit moves nothing)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    usePanda.getState().ensureConnection('live');
    const port = connectionStorePort('live');
    port.adoptSession('s-1', '/a');
    const snapshot = port.stageSession('s-2', '/b');

    port.removeSession('s-1'); // the session the connection had settled on
    port.commitStagedSession(snapshot); // the in-flight load lands late

    const state = usePanda.getState();
    // The delete bumped the generation: the commit is superseded — it must
    // not route the connection onto a world whose predecessor was deleted.
    expect(state.activeSessionId).toBeNull(); // cleared by the delete itself
    expect(state.connections['live']!.connection.sessionId).toBeNull(); // unanchored by the delete (#59), untouched by the stale commit
    expect(state.connections['live']!.switching).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('superseded'));
    warnSpy.mockRestore();
  });
});

describe('multi-connection foreground (issue #21)', () => {
  it('setActiveConnection moves both pointers to the target connection', () => {
    usePanda.getState().ensureConnection('a');
    connectionStorePort('a').adoptSession('s-a', '/a');
    usePanda.getState().ensureConnection('b');
    connectionStorePort('b').adoptSession('s-b', '/b');

    usePanda.getState().setActiveConnection('a');

    const state = usePanda.getState();
    expect(state.activeConnectionId).toBe('a');
    expect(state.activeSessionId).toBe('s-a'); // the target's settled session
  });

  it('setActiveConnection can point the UI at a specific retained document', () => {
    usePanda.getState().ensureConnection('b');
    const port = connectionStorePort('b');
    port.adoptSession('s-b1', '/b');
    port.adoptSession('s-b2', '/b'); // both documents retained

    usePanda.getState().setActiveConnection('b', 's-b1');

    expect(usePanda.getState().activeSessionId).toBe('s-b1');
    expect(usePanda.getState().connections['b']!.connection.sessionId).toBe('s-b2'); // settled pointer untouched
  });

  it('setActiveConnection warns loudly on an unknown id', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    usePanda.getState().setActiveConnection('ghost');
    expect(usePanda.getState().activeConnectionId).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown connection "ghost"'));
    warnSpy.mockRestore();
  });

  it('a turn settling in the background marks unread; foregrounding clears it', () => {
    usePanda.getState().ensureConnection('a');
    usePanda.getState().ensureConnection('b');
    const b = connectionStorePort('b');
    b.adoptSession('s-b', '/b');
    expect(usePanda.getState().activeConnectionId).toBe('b');

    // 'a' becomes the foreground; 'b' runs a turn in the background.
    usePanda.getState().setActiveConnection('a');
    b.update({ sessionUpdate: 'status_changed', status: 'running' });
    b.update({ sessionUpdate: 'status_changed', status: 'idle' });

    expect(usePanda.getState().connections['b']!.unreadCompletion).toBe(true);
    expect(connectionLifecycle(usePanda.getState().connections['b']!).attention).toContain('unread-completion');

    usePanda.getState().setActiveConnection('b');
    expect(usePanda.getState().connections['b']!.unreadCompletion).toBe(false);
  });

  it('a turn settling in the foreground never marks unread', () => {
    usePanda.getState().ensureConnection('live');
    const port = connectionStorePort('live');
    port.adoptSession('s-1', '/a');
    port.update({ sessionUpdate: 'status_changed', status: 'running' });
    port.update({ sessionUpdate: 'status_changed', status: 'idle' });
    expect(usePanda.getState().connections['live']!.unreadCompletion).toBe(false);
  });

  it('unread also fires with no foreground connection at all', () => {
    // The foreground slot was removed while a background one was running.
    usePanda.getState().ensureConnection('fg');
    usePanda.getState().ensureConnection('bg');
    const bg = connectionStorePort('bg');
    bg.adoptSession('s-bg', '/bg');
    usePanda.getState().setActiveConnection('fg'); // bg is background
    usePanda.getState().closeConnection('fg'); // foreground removed — none left
    expect(usePanda.getState().activeConnectionId).toBeNull();

    bg.update({ sessionUpdate: 'status_changed', status: 'running' });
    bg.update({ sessionUpdate: 'status_changed', status: 'idle' });
    expect(usePanda.getState().connections['bg']!.unreadCompletion).toBe(true);
  });

  it('orderedConnectionIds: foreground first, then recent activity, demo excluded', () => {
    vi.useFakeTimers();
    try {
      usePanda.getState().ensureConnection('idle-old');
      usePanda.getState().ensureConnection('recent');
      usePanda.getState().ensureConnection('never');
      usePanda.getState().ensureConnection(DEMO_CONNECTION_ID);
      connectionStorePort('idle-old').adoptSession('s', '/x'); // older activity
      vi.advanceTimersByTime(50);
      connectionStorePort('recent').adoptSession('s', '/x'); // newer activity

      usePanda.getState().setActiveConnection('never');

      expect(orderedConnectionIds(usePanda.getState())).toEqual(['never', 'recent', 'idle-old']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('indicator derivations: running and pending permissions light attention', () => {
    usePanda.getState().ensureConnection('live');
    const port = connectionStorePort('live');
    port.adoptSession('s-1', '/a');
    expect(connectionLifecycle(usePanda.getState().connections['live']!).running).toBe(false);

    port.update({ sessionUpdate: 'status_changed', status: 'running' });
    expect(connectionLifecycle(usePanda.getState().connections['live']!).running).toBe(true);

    port.update({
      sessionUpdate: 'permission_requested',
      request: {
        toolCallId: 't-1',
        title: 'Edit file',
        options: [{ id: 'o-1', name: 'Allow once', kind: 'allow_once' }],
      },
    });
    port.update({ sessionUpdate: 'status_changed', status: 'requires_action' });
    const attention = connectionLifecycle(usePanda.getState().connections['live']!).attention;
    expect(attention).toContain('pending-permission');
    expect(attention.length).toBeGreaterThan(0);

    port.update({ sessionUpdate: 'status_changed', status: 'idle' }); // foreground — no unread from this settle
    expect(connectionLifecycle(usePanda.getState().connections['live']!).attention).toContain('pending-permission'); // permission still pending
  });

  it('a connection error lights attention until it clears', () => {
    usePanda.getState().ensureConnection('live');
    const port = connectionStorePort('live');
    port.setConnection({ status: 'error', error: '连接失败: boom' });
    expect(connectionLifecycle(usePanda.getState().connections['live']!).attention).toContain('connection-error');
    port.setConnection({ status: 'connected', error: null });
    expect(connectionLifecycle(usePanda.getState().connections['live']!).attention).toEqual([]);
  });
});

describe('selection pointer invariants (#59)', () => {
  /** activeSessionId must mirror the foreground connection's anchor. */
  const expectPointerMirrorsAnchor = () => {
    const s = usePanda.getState();
    const anchor =
      s.activeConnectionId !== null
        ? (s.connections[s.activeConnectionId]?.connection.sessionId ?? null)
        : null;
    expect(s.activeSessionId).toBe(anchor);
  };

  it('adopt on the foreground connection moves both pointers together', () => {
    usePanda.getState().ensureConnection('live');
    connectionStorePort('live').adoptSession('s-1', '/a');
    expectPointerMirrorsAnchor();
    expect(usePanda.getState().activeSessionId).toBe('s-1');
  });

  it('adopt on a background connection leaves the UI pointer alone', () => {
    usePanda.getState().ensureConnection('fg');
    const fg = connectionStorePort('fg');
    fg.adoptSession('s-1', '/a');
    usePanda.getState().seedConnection('bg');
    connectionStorePort('bg').adoptSession('s-2', '/b');
    expectPointerMirrorsAnchor();
    expect(usePanda.getState().activeSessionId).toBe('s-1');
  });

  it('a committed switch moves both pointers; a rollback moves neither', () => {
    usePanda.getState().ensureConnection('live');
    const port = connectionStorePort('live');
    port.adoptSession('s-1', '/a');
    const committed = port.stageSession('s-2', '/b');
    expect(usePanda.getState().activeSessionId).toBe('s-1'); // in flight: UI stays put
    port.commitStagedSession(committed);
    expectPointerMirrorsAnchor();
    expect(usePanda.getState().activeSessionId).toBe('s-2');

    const rolledBack = port.stageSession('s-1', '/a');
    port.rollbackStagedSession(rolledBack);
    expectPointerMirrorsAnchor();
    expect(usePanda.getState().activeSessionId).toBe('s-2');
  });

  it('deleting the session the UI is looking at clears the pointer AND the anchor (#59 dangling fix)', () => {
    usePanda.getState().ensureConnection('live');
    const port = connectionStorePort('live');
    port.adoptSession('s-1', '/a');
    port.removeSession('s-1');
    expect(usePanda.getState().activeSessionId).toBe(null);
    expect(usePanda.getState().connections['live']!.connection.sessionId).toBe(null);
    expectPointerMirrorsAnchor();
  });

  it('deleting a background connection’s session unanchors it without touching the foreground', () => {
    usePanda.getState().ensureConnection('fg');
    connectionStorePort('fg').adoptSession('s-1', '/a');
    usePanda.getState().seedConnection('bg');
    const bg = connectionStorePort('bg');
    bg.adoptSession('s-2', '/b');
    bg.removeSession('s-2');
    expect(usePanda.getState().connections['bg']!.connection.sessionId).toBe(null);
    expect(usePanda.getState().activeSessionId).toBe('s-1');
    expectPointerMirrorsAnchor();
  });

  it('closing the foreground connection clears both pointers', () => {
    usePanda.getState().ensureConnection('live');
    connectionStorePort('live').adoptSession('s-1', '/a');
    usePanda.getState().closeConnection('live');
    expect(usePanda.getState().activeSessionId).toBe(null);
    expectPointerMirrorsAnchor();
  });

  it('switching the foreground re-derives the UI pointer from the target’s anchor', () => {
    usePanda.getState().ensureConnection('a');
    connectionStorePort('a').adoptSession('s-1', '/a');
    usePanda.getState().ensureConnection('b');
    connectionStorePort('b').adoptSession('s-2', '/b');
    usePanda.getState().setActiveConnection('b');
    expectPointerMirrorsAnchor();
    expect(usePanda.getState().activeSessionId).toBe('s-2');
    // Switching to an anchorless connection settles on nothing.
    usePanda.getState().seedConnection('fresh');
    usePanda.getState().setActiveConnection('fresh');
    expectPointerMirrorsAnchor();
    expect(usePanda.getState().activeSessionId).toBe(null);
  });

  it('retained-document viewing is the explicit divergence: the UI pointer shows the requested session, the anchor does not move', () => {
    usePanda.getState().ensureConnection('live');
    connectionStorePort('live').adoptSession('s-1', '/a');
    connectionStorePort('live').adoptSession('s-2', '/b');
    connectionStorePort('live').adoptSession('s-1', '/a');
    usePanda.getState().setActiveConnection('live', 's-2');
    expect(usePanda.getState().activeSessionId).toBe('s-2');
    expect(usePanda.getState().connections['live']!.connection.sessionId).toBe('s-1');
  });
});
