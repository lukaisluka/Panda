import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveAcpClient, LiveClientHandlers } from './acp/LiveAcpClient';
import {
  __liveConnectionIds,
  __resetLiveConnections,
  __setDefaultClientFactory,
  connectLiveConnection,
  deleteLiveSession,
  disconnectLiveConnection,
  foregroundConnection,
  lastConnectionDefaults,
  newDirectConnectionId,
  newLiveSession,
  openLiveSession,
  persistSessionsSnapshot,
  seedProfileSlots,
  removeLiveConnection,
  type SessionStorage,
} from './liveConnections';
import { connectionStorePort, usePanda } from './store';
import { loadProfiles, saveProfiles, type AgentProfile } from './profiles';
import { WORKSPACE_NONE_CWD, type Workspace } from './workspace';

/**
 * Manager-level scenarios for issue #21: parallel connections, 断连隔离,
 * direct-slot teardown, foreground switching and unread signaling. The ACP
 * client is stubbed through the factory seam — the stub captures the wired
 * handlers (the real routing under test) and mimics the pieces of client
 * behavior the manager depends on (disconnect reports synchronously).
 */

class MemoryStorage implements SessionStorage {
  readonly entries = new Map<string, string>();
  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
}

const profile = (id: string, url = `ws://${id}/acp`, workspace: Workspace = { kind: 'local-directory', path: `/${id}` }): AgentProfile => ({
  id,
  name: id,
  url,
  workspace,
});

type StubbedClient = { handlers: LiveClientHandlers; client: LiveAcpClient };

/** Installs stub clients and returns them in creation order. */
function installStubClients(): StubbedClient[] {
  const created: StubbedClient[] = [];
  __setDefaultClientFactory((handlers) => {
    const stub: StubbedClient = {
      handlers,
      client: {
        connect: vi.fn(async () => {}),
        // The real client reports a clean disconnect synchronously.
        disconnect: vi.fn(() => handlers.onDisconnected(null)),
        newSession: vi.fn(async () => {}),
        loadSession: vi.fn(async () => {}),
        deleteSession: vi.fn(async () => {}),
        send: vi.fn(async () => {}),
        resolvePermission: vi.fn(),
        cancel: vi.fn(),
      } as unknown as LiveAcpClient,
    };
    created.push(stub);
    return stub.client;
  });
  return created;
}

/** Connects a profile and drives it to "connected with one session". */
async function connectedStub(id: string, stubs: StubbedClient[], sessionId: string): Promise<void> {
  await connectLiveConnection(id, `ws://${id}/acp`, { kind: 'local-directory', path: `/${id}` });
  const stub = stubs.at(-1)!;
  stub.handlers.onSessionId(sessionId, `/${id}`);
  stub.handlers.onConnected({ agentName: `${id}-agent`, protocolVersion: 1 });
}

beforeEach(() => {
  // Spies first: the manager reset below fires disconnect handlers whose
  // store writes warn into the already-reset state.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  usePanda.setState({
    mode: 'demo',
    connections: {},
    activeConnectionId: null,
    activeSessionId: null,
    selectionGeneration: 0,
  });
  __resetLiveConnections();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('parallel connections (issue #21)', () => {
  it('routes each connection updates into its own slot only', async () => {
    const stubs = installStubClients();
    await connectedStub('agent-a', stubs, 's-a');
    await connectedStub('agent-b', stubs, 's-b');

    stubs[0]!.handlers.onUpdate({
      sessionUpdate: 'user_message',
      content: [{ type: 'text', text: 'to A' }],
    });

    const state = usePanda.getState();
    expect(state.connections['agent-a']!.docs['s-a']!.turns).toHaveLength(1);
    expect(state.connections['agent-b']!.docs['s-b']!.turns).toHaveLength(0);
    // Connecting B foregrounded it; A keeps its transcript in its own slot.
    expect(state.activeConnectionId).toBe('agent-b');
  });

  it('断连隔离: disconnecting one connection leaves the other intact', async () => {
    const stubs = installStubClients();
    await connectedStub('agent-a', stubs, 's-a');
    await connectedStub('agent-b', stubs, 's-b');
    stubs[1]!.handlers.onUpdate({
      sessionUpdate: 'user_message',
      content: [{ type: 'text', text: 'B transcript' }],
    });

    disconnectLiveConnection('agent-a');

    const state = usePanda.getState();
    expect(state.connections['agent-a']!.connection.status).toBe('disconnected');
    expect(state.connections['agent-b']!.connection.status).toBe('connected');
    expect(state.connections['agent-b']!.docs['s-b']!.turns).toHaveLength(1);
  });

  it('profile disconnect retains the slot (可重连), removal destroys it', async () => {
    const stubs = installStubClients();
    await connectedStub('agent-a', stubs, 's-a');
    stubs[0]!.handlers.onUpdate({
      sessionUpdate: 'user_message',
      content: [{ type: 'text', text: 'kept until removal' }],
    });

    disconnectLiveConnection('agent-a');
    expect(usePanda.getState().connections['agent-a']).toBeDefined();

    removeLiveConnection('agent-a');
    expect(usePanda.getState().connections['agent-a']).toBeUndefined();
    expect(usePanda.getState().activeConnectionId).toBeNull(); // was foreground
  });

  it('临时直连 ends with its disconnect — no slot, no documents', async () => {
    const stubs = installStubClients();
    const directId = newDirectConnectionId();
    await connectedStub(directId, stubs, 's-direct');

    disconnectLiveConnection(directId);

    expect(usePanda.getState().connections[directId]).toBeUndefined();
    expect(__liveConnectionIds()).not.toContain(directId);
  });

  it('a background turn completion marks unread; foregrounding clears it', async () => {
    const stubs = installStubClients();
    await connectedStub('agent-a', stubs, 's-a');
    await connectedStub('agent-b', stubs, 's-b');
    foregroundConnection('agent-a'); // B is now background

    stubs[1]!.handlers.onUpdate({ sessionUpdate: 'status_changed', status: 'running' });
    stubs[1]!.handlers.onUpdate({ sessionUpdate: 'status_changed', status: 'idle' });
    expect(usePanda.getState().connections['agent-b']!.unreadCompletion).toBe(true);

    foregroundConnection('agent-b');
    const state = usePanda.getState();
    expect(state.connections['agent-b']!.unreadCompletion).toBe(false);
    expect(state.activeConnectionId).toBe('agent-b');
    expect(state.activeSessionId).toBe('s-b');
  });

  it('foregroundConnection on an unknown id warns and does nothing', () => {
    foregroundConnection('ghost');
    expect(usePanda.getState().activeConnectionId).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('unknown connection "ghost"'));
  });
});

describe('opening sessions across connections (issue #21)', () => {
  it('offline slot: points the UI at the retained document (查看历史)', async () => {
    const stubs = installStubClients();
    await connectedStub('agent-a', stubs, 's-a1');
    stubs[0]!.handlers.onUpdate({
      sessionUpdate: 'user_message',
      content: [{ type: 'text', text: 'history' }],
    });
    disconnectLiveConnection('agent-a');
    await connectedStub('agent-b', stubs, 's-b'); // foreground elsewhere

    openLiveSession('agent-a', 's-a1', '/agent-a');

    const state = usePanda.getState();
    expect(state.activeConnectionId).toBe('agent-a');
    expect(state.activeSessionId).toBe('s-a1');
    expect(state.mode).toBe('live');
  });

  it('connected background slot: foregrounds, then transactional load', async () => {
    const stubs = installStubClients();
    await connectedStub('agent-a', stubs, 's-a');
    await connectedStub('agent-b', stubs, 's-b'); // foreground

    openLiveSession('agent-a', 's-a2', '/agent-a');

    expect(usePanda.getState().activeConnectionId).toBe('agent-a');
    // The settled pointer waits for the transactional commit; the load was issued.
    expect(stubs[0]!.client.loadSession).toHaveBeenCalledWith('s-a2', '/agent-a');
    expect(usePanda.getState().connections['agent-a']!.connection.sessionId).toBe('s-a');
  });

  it('the settled session of a background slot foregrounds without a load', async () => {
    const stubs = installStubClients();
    await connectedStub('agent-a', stubs, 's-a');
    await connectedStub('agent-b', stubs, 's-b');

    openLiveSession('agent-a', 's-a', '/agent-a');

    expect(usePanda.getState().activeConnectionId).toBe('agent-a');
    expect(usePanda.getState().activeSessionId).toBe('s-a');
    expect(stubs[0]!.client.loadSession).not.toHaveBeenCalled();
  });
});

describe('offline agent seeding (phase 3)', () => {
  it('seeds disconnected slots from the endpoint memory; the first takes the foreground', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'panda.sessions:ws://p/acp',
      JSON.stringify([{ sessionId: 'known', cwd: '/p', title: 'Remembered', updatedAt: null }]),
    );
    usePanda.getState().setMode('live');

    seedProfileSlots([profile('p'), profile('q')], storage);

    const slot = usePanda.getState().connections['p']!;
    expect(slot.connection.status).toBe('disconnected');
    expect(slot.connection.url).toBe('ws://p/acp');
    expect(slot.sessions.map((entry) => entry.sessionId)).toEqual(['known']);
    expect(usePanda.getState().connections['q']!.connection.status).toBe('disconnected');
    // An empty foreground may be taken; a later seed never steals it.
    expect(usePanda.getState().activeConnectionId).toBe('p');
  });

  it('an existing slot is left untouched — its resume state and foreground survive', async () => {
    const stubs = installStubClients();
    await connectedStub('p', stubs, 's-p');
    // The connection dies unexpectedly: error + resumable session id stay.
    stubs[0]!.handlers.onDisconnected('与服务器的连接已断开');
    await connectedStub('other', stubs, 's-o');

    seedProfileSlots([profile('p')]);

    const slot = usePanda.getState().connections['p']!;
    expect(usePanda.getState().activeConnectionId).toBe('other');
    expect(slot.connection.status).toBe('error'); // not clobbered by seeding
    expect(slot.connection.sessionId).toBe('s-p');
  });

  it('seeds regardless of mode — seeding is slot preparation, demo renders none of it', () => {
    const storage = new MemoryStorage();
    usePanda.getState().setMode('demo');

    seedProfileSlots([profile('p')], storage);

    expect(usePanda.getState().connections['p']!.connection.status).toBe('disconnected');
    expect(usePanda.getState().mode).toBe('demo');
  });
});

describe('per-endpoint session persistence (issue #21)', () => {
  it('unions the lists of parallel connections to the same endpoint', () => {
    const storage = new MemoryStorage();
    persistSessionsSnapshot(
      [
        {
          url: 'ws://shared/acp',
          sessions: [
            { sessionId: 's-1', cwd: '/a', title: 'One', updatedAt: null },
            { sessionId: 's-2', cwd: '/a', title: null, updatedAt: null },
          ],
        },
        {
          url: 'ws://shared/acp',
          sessions: [
            { sessionId: 's-2', cwd: '/b', title: 'Two', updatedAt: '2026-09-04T00:00:00Z' },
            { sessionId: 's-3', cwd: '/b', title: null, updatedAt: null },
          ],
        },
        {
          url: null, // offline slot — nothing to persist under
          sessions: [{ sessionId: 's-4', cwd: '/x', title: null, updatedAt: null }],
        },
      ],
      storage,
    );

    const persisted = JSON.parse(storage.entries.get('panda.sessions:ws://shared/acp')!) as Array<{
      sessionId: string;
      title: string | null;
    }>;
    expect(persisted.map((entry) => entry.sessionId).sort()).toEqual(['s-1', 's-2', 's-3']);
    expect(persisted.find((entry) => entry.sessionId === 's-2')).toMatchObject({ title: 'Two' });
    expect(storage.entries.has('panda.sessions:null')).toBe(false);
  });

  it('keeps already-persisted sessions of connections that no longer exist', () => {
    const storage = new MemoryStorage();
    // A removed connection's session is still the agent server's reality —
    // the endpoint memory must not lose it just because no live slot lists it.
    storage.setItem(
      'panda.sessions:ws://x/acp',
      JSON.stringify([{ sessionId: 'gone', cwd: '/x', title: '旧会话', updatedAt: null }]),
    );

    persistSessionsSnapshot(
      [{ url: 'ws://x/acp', sessions: [{ sessionId: 'live', cwd: '/x', title: null, updatedAt: null }] }],
      storage,
    );

    const persisted = JSON.parse(storage.entries.get('panda.sessions:ws://x/acp')!) as Array<{
      sessionId: string;
    }>;
    expect(persisted.map((entry) => entry.sessionId).sort()).toEqual(['gone', 'live']);
  });

  it('caps the endpoint memory at the newest PERSIST_LIMIT entries', () => {
    const storage = new MemoryStorage();
    const many = Array.from({ length: 60 }, (_, i) => ({
      sessionId: `s-${i}`,
      cwd: '/x',
      title: null,
      // Zero-padded so lexicographic order matches chronological order.
      updatedAt: `2026-09-04T00:${String(i).padStart(2, '0')}:00Z`,
    }));

    persistSessionsSnapshot([{ url: 'ws://x/acp', sessions: many }], storage);

    const persisted = JSON.parse(storage.entries.get('panda.sessions:ws://x/acp')!) as Array<{
      sessionId: string;
    }>;
    expect(persisted).toHaveLength(50);
    expect(persisted[0]).toMatchObject({ sessionId: 's-59' });
    expect(persisted.at(-1)).toMatchObject({ sessionId: 's-10' });
  });

  it('deleting a session purges it from the endpoint memory (no resurrection)', async () => {
    const stubs = installStubClients();
    await connectedStub('p', stubs, 's-keep');

    const storage = new MemoryStorage();
    storage.setItem(
      'panda.sessions:ws://p/acp',
      JSON.stringify([
        { sessionId: 's-keep', cwd: '/p', title: null, updatedAt: null },
        { sessionId: 's-dead', cwd: '/p', title: null, updatedAt: null },
      ]),
    );

    await deleteLiveSession('p', 's-dead', storage);

    const persisted = JSON.parse(storage.entries.get('panda.sessions:ws://p/acp')!) as Array<{
      sessionId: string;
    }>;
    expect(persisted.map((entry) => entry.sessionId)).toEqual(['s-keep']);
    // And the persist union does not resurrect it afterwards.
    persistSessionsSnapshot(
      [{ url: 'ws://p/acp', sessions: [{ sessionId: 's-keep', cwd: '/p', title: null, updatedAt: null }] }],
      storage,
    );
    const after = JSON.parse(storage.entries.get('panda.sessions:ws://p/acp')!) as Array<{
      sessionId: string;
    }>;
    expect(after.map((entry) => entry.sessionId)).toEqual(['s-keep']);
  });
});

describe('工作区 (issue #23, ADR 0005)', () => {
  /** Node has no localStorage: the form/remember paths need a stubbed one. */
  function stubLocalStorage(): Map<string, string> {
    const entries = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
      removeItem: (key: string) => entries.delete(key),
    });
    return entries;
  }

  it('无工作区 connects with the placeholder cwd and remembers it back as none', async () => {
    const entries = stubLocalStorage();
    const stubs = installStubClients();

    await connectLiveConnection('agent-n', 'ws://agent-n/acp', { kind: 'none' });
    const stub = stubs[0]!;

    // The single derivation point: none → WORKSPACE_NONE_CWD on the wire.
    expect(stub.client.connect).toHaveBeenCalledWith(
      expect.anything(),
      WORKSPACE_NONE_CWD,
      undefined,
    );
    expect(usePanda.getState().connections['agent-n']!.connection.cwd).toBe(WORKSPACE_NONE_CWD);
    // The remembered default reads back as 无工作区 (`/` ≡ none, ADR 0005).
    expect(entries.get('panda.acp.cwd')).toBe(WORKSPACE_NONE_CWD);
    expect(lastConnectionDefaults()).toEqual({ url: 'ws://agent-n/acp', workspace: { kind: 'none' } });

    stub.handlers.onSessionId('s-n', WORKSPACE_NONE_CWD);
    stub.handlers.onConnected({ agentName: 'n-agent', protocolVersion: 1 });
    await newLiveSession(WORKSPACE_NONE_CWD);
    expect(stub.client.newSession).toHaveBeenCalledWith(WORKSPACE_NONE_CWD);
  });

  it('resuming a 无工作区 session sends the agent-reported cwd verbatim', async () => {
    const stubs = installStubClients();
    await connectedStub('agent-n', stubs, 's-a');
    // A session the agent reports with the placeholder cwd (created by Panda
    // under 无工作区) must resume with exactly that string — deepagents-acp
    // enforces byte-equality on session/load.
    connectionStorePort('agent-n').mergeSessions([
      { sessionId: 's-none', cwd: WORKSPACE_NONE_CWD, title: null, updatedAt: null },
      { sessionId: 's-foreign', cwd: '/real/foreign', title: null, updatedAt: null },
    ]);

    openLiveSession('agent-n', 's-none', WORKSPACE_NONE_CWD);
    expect(stubs[0]!.client.loadSession).toHaveBeenCalledWith('s-none', WORKSPACE_NONE_CWD);

    openLiveSession('agent-n', 's-foreign', '/real/foreign');
    expect(stubs[0]!.client.loadSession).toHaveBeenCalledWith('s-foreign', '/real/foreign');
  });

  it('a local-directory workspace without a path is rejected before connecting', async () => {
    const stubs = installStubClients();

    await connectLiveConnection('agent-e', 'ws://agent-e/acp', { kind: 'local-directory', path: '   ' });

    expect(stubs).toHaveLength(0);
    expect(usePanda.getState().connections['agent-e']).toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('workspace path are required'));
  });

  it('profile connect-time write-back preserves the workspace kind', async () => {
    const entries = stubLocalStorage();
    const p = profile('p', 'ws://p/acp', { kind: 'none' });
    saveProfiles([p]);
    const stubs = installStubClients();

    await connectLiveConnection('p', 'ws://p/acp', { kind: 'none' }, { profileId: 'p' });
    stubs[0]!.handlers.onConnected({ agentName: 'p-agent', protocolVersion: 1 });

    const persisted = loadProfiles();
    expect(persisted).toEqual([p]);
    expect(entries.get('panda.profiles')).toContain('"kind":"none"');
  });
});
