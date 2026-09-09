import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, agent, methods, type AnyMessage } from '@agentclientprotocol/sdk';
import type { LiveAcpClient, LiveClientHandlers } from './acp/LiveAcpClient';
import {
  __liveConnectionIds,
  __resetLiveConnections,
  __setDefaultClientFactory,
  __setTestTransportFactory,
  connectLiveConnection,
  deleteLiveSession,
  disconnectLiveConnection,
  foregroundConnection,
  lastConnectionDefaults,
  newDirectConnectionId,
  newLiveSession,
  openLiveSession,
  persistSessionsSnapshot,
  reconnectLiveConnection,
  removeLiveConnection,
  restoreEndpointSessions,
  seedProfileSlots,
  sweepFailedDirectSlots,
  testLiveTarget,
  type SessionStorage,
} from './liveConnections';
import {
  connectionStorePort,
  emptyConnectionState,
  usePanda,
  type ConnectionState,
  type SessionEntry,
} from './store';
import { emptySession } from './protocol/reducer';
import { StreamTransport } from './acp/transport/StreamTransport';
import { subscribeUserNotices, type UserNotice } from './userNotice';
import { loadProfiles, saveProfiles, type AgentProfile } from './profiles';
import type { AcpTransport } from './acp/transport/AcpTransport';
import { setStdioTransportFactory, type StdioAgentConfig } from './acp/transport/stdioHost';
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
  kind: 'websocket',
  url,
  workspace,
  mcpServerIds: [],
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
  await connectLiveConnection(id, { kind: 'websocket', url: `ws://${id}/acp` }, { kind: 'local-directory', path: `/${id}` });
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

describe('row-level action routing (bug hunt #1/#5)', () => {
  it('#1 错误块重连只拨本 slot:后台 error 的 agent-b 重连,前台健康的 agent-a 不被拆', async () => {
    const stubs = installStubClients();
    await connectedStub('agent-a', stubs, 's-a');
    await connectedStub('agent-b', stubs, 's-b');
    foregroundConnection('agent-a'); // a 是前台;b 即将转入后台错误

    stubs[1]!.handlers.onDisconnected('boom'); // b: error, sessionId 保留

    reconnectLiveConnection('agent-b');

    expect(stubs[1]!.client.connect).toHaveBeenCalledTimes(2); // b 重拨
    expect(stubs[0]!.client.connect).toHaveBeenCalledTimes(1); // a 从未被重拨
    expect(stubs[0]!.client.disconnect).not.toHaveBeenCalled(); // 健康前台未被错杀
  });

  it('#1 resume 重连保留会话指针,且前台为空时行级重连仍可达', async () => {
    const stubs = installStubClients();
    await connectedStub('agent-a', stubs, 's-a');
    stubs[0]!.handlers.onDisconnected('boom');
    usePanda.setState({ activeConnectionId: null }); // 前台为空:旧按钮是死点

    reconnectLiveConnection('agent-a', { resume: true });

    expect(stubs[0]!.client.connect).toHaveBeenCalledTimes(2);
    expect(usePanda.getState().connections['agent-a']!.connection.sessionId).toBe('s-a');
  });

  it('#5 行级 newSession 建在点中的连接上,前台跟随它', async () => {
    const stubs = installStubClients();
    await connectedStub('agent-a', stubs, 's-a');
    await connectedStub('agent-b', stubs, 's-b');
    foregroundConnection('agent-a'); // 点 b 的行时 a 是前台

    await newLiveSession('/agent-b', 'agent-b');

    expect(stubs[1]!.client.newSession).toHaveBeenCalledWith('/agent-b');
    expect(stubs[0]!.client.newSession).not.toHaveBeenCalled(); // 没建在 a 上
    expect(usePanda.getState().activeConnectionId).toBe('agent-b'); // 用户落在 b
  });

  it('#5 显式目标没有连接时大声跳过', async () => {
    const stubs = installStubClients();
    await connectedStub('agent-a', stubs, 's-a');
    await newLiveSession('/x', 'ghost');
    expect(stubs[0]!.client.newSession).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith('[panda/acp] newSession ignored: no live connection "ghost"');
  });
});

describe('ignored reconnects answer with a toast (#238)', () => {
  it('a direct slot with no remembered target toasts the recovery instead of dead-clicking', () => {
    const notices: UserNotice[] = [];
    const unsubscribe = subscribeUserNotices((notice) => notices.push(notice));

    reconnectLiveConnection('direct:ghost');

    expect(notices).toHaveLength(1);
    expect(notices[0]!.kind).toBe('error');
    expect(notices[0]!.message).toBe(
      'This session has no remembered connection target — connect again from New session.',
    );
    // The console trace stays — the toast answers the user, the warn answers the next diagnosis.
    expect(console.warn).toHaveBeenCalledWith('[panda/acp] reconnect ignored: slot "direct:ghost" has no remembered target');
    unsubscribe();
  });

  it('a reconnect with no target connection (null id) toasts the pick-an-agent copy', () => {
    const notices: UserNotice[] = [];
    const unsubscribe = subscribeUserNotices((notice) => notices.push(notice));

    reconnectLiveConnection(null);

    expect(notices).toHaveLength(1);
    expect(notices[0]!.kind).toBe('error');
    expect(notices[0]!.message).toBe('No connection selected — pick an agent in the sidebar first.');
    expect(console.warn).toHaveBeenCalledWith('[panda/acp] reconnect ignored: no target connection');
    unsubscribe();
  });

  it('a slot that lost its store row toasts the no-workspace recovery', async () => {
    const stubs = installStubClients();
    await connectedStub('agent-a', stubs, 's-a');
    // Entry (with remembered target) alive, store row gone — the drift shape exit 3 defends against.
    usePanda.getState().closeConnection('agent-a');
    const notices: UserNotice[] = [];
    const unsubscribe = subscribeUserNotices((notice) => notices.push(notice));

    reconnectLiveConnection('agent-a');

    expect(notices).toHaveLength(1);
    expect(notices[0]!.kind).toBe('error');
    expect(notices[0]!.message).toBe('This session has no remembered workspace — connect again from New session.');
    expect(console.warn).toHaveBeenCalledWith('[panda/acp] reconnect ignored: slot "agent-a" has no remembered workspace');
    expect(stubs[0]!.client.connect).toHaveBeenCalledTimes(1); // no redial happened
    unsubscribe();
  });

  it('a proceeding reconnect stays silent — the dial failure owns the error card, no double toast', async () => {
    const stubs = installStubClients();
    await connectedStub('agent-a', stubs, 's-a');
    const notices: UserNotice[] = [];
    const unsubscribe = subscribeUserNotices((notice) => notices.push(notice));

    reconnectLiveConnection('agent-a');
    await vi.waitFor(() => expect(stubs[0]!.client.connect).toHaveBeenCalledTimes(2));

    expect(notices).toHaveLength(0);
    unsubscribe();
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

  it('#217 a failed switch rolls back, names the session in the toast, and offers Retry', async () => {
    const stubs = installStubClients();
    await connectedStub('agent-a', stubs, 's-a');
    // The target session carries a title — the toast must name it, not the id.
    const state = usePanda.getState();
    usePanda.setState({
      connections: {
        ...state.connections,
        'agent-a': {
          ...state.connections['agent-a']!,
          sessions: [{ sessionId: 's-a2', title: 'Refactor plan', cwd: '/agent-a', updatedAt: null }],
        },
      },
    });
    const notices: UserNotice[] = [];
    const unsubscribe = subscribeUserNotices((notice) => notices.push(notice));

    openLiveSession('agent-a', 's-a2', '/agent-a');
    stubs[0]!.handlers.onSessionSwitchStage('s-a2', '/agent-a', 7);
    stubs[0]!.handlers.onSessionSwitchRollback('agent exploded', 7);

    const message = 'Switching to \u201cRefactor plan\u201d failed: agent exploded';
    expect(usePanda.getState().connections['agent-a']!.connection.error).toBe(message);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.kind).toBe('error');
    expect(notices[0]!.message).toBe(message);
    expect(notices[0]!.action?.label).toBe('Retry');
    // Retry re-issues the load for the same session.
    notices[0]!.action!.run();
    expect(stubs[0]!.client.loadSession).toHaveBeenCalledWith('s-a2', '/agent-a');
    expect(stubs[0]!.client.loadSession).toHaveBeenCalledTimes(2);
    unsubscribe();
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

describe('local activity stamping (#175)', () => {
  it('a streamed reply stamps the session entry though the agent reported nothing', async () => {
    const stubs = installStubClients();
    await connectedStub('agent-a', stubs, 's-a');

    stubs[0]!.handlers.onUpdate({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm',
      content: { type: 'text', text: 'streaming' },
    });

    expect(usePanda.getState().connections['agent-a']!.sessions.find((e) => e.sessionId === 's-a')!.updatedAt)
      .not.toBeNull();
  });

  it('session_info_update overwrites the local stamp — agent report wins on arrival', async () => {
    const stubs = installStubClients();
    await connectedStub('agent-a', stubs, 's-a');
    stubs[0]!.handlers.onUpdate({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm',
      content: { type: 'text', text: 'x' },
    });

    stubs[0]!.handlers.onSessionInfo('s-a', { updatedAt: '2020-01-01T00:00:00Z' });

    expect(usePanda.getState().connections['agent-a']!.sessions.find((e) => e.sessionId === 's-a')!.updatedAt)
      .toBe('2020-01-01T00:00:00Z');
  });

  it('clicking a titled session keeps its stamp — a load-time title-only info must not erase it', async () => {
    const stubs = installStubClients();
    await connectedStub('agent-a', stubs, 's-a');
    // The clicked session: known title + a stamp, exactly what a prior
    // activity + session_info_update leave behind.
    stubs[0]!.handlers.onSessions([
      { sessionId: 's-a2', cwd: '/agent-a', title: '已命名', updatedAt: '2026-01-02T00:00:00Z' },
    ]);
    const before = usePanda.getState().connections['agent-a']!.sessions
      .find((e) => e.sessionId === 's-a2')!.updatedAt;

    // The click: full loadSessionInternal order, including the title-only
    // session_info_update the test agent sends before its response resolves.
    stubs[0]!.handlers.onSessionSwitchStage('s-a2', '/agent-a', 1);
    stubs[0]!.handlers.onReplayStart();
    stubs[0]!.handlers.onUpdate({ sessionUpdate: 'user_message', content: [{ type: 'text', text: 'history' }] });
    stubs[0]!.handlers.onSessionInfo('s-a2', { title: '已命名', updatedAt: undefined });
    stubs[0]!.handlers.onSessionSwitchCommit(1);

    expect(usePanda.getState().connections['agent-a']!.sessions.find((e) => e.sessionId === 's-a2')!.updatedAt)
      .toBe(before);
  });

  it('a session/load replay through the wired handlers stamps nothing', async () => {
    const stubs = installStubClients();
    await connectedStub('agent-a', stubs, 's-a');
    // A second session with an agent-reported time, as session/list would deliver.
    stubs[0]!.handlers.onSessions([
      { sessionId: 's-a2', cwd: '/agent-a', title: null, updatedAt: '2026-01-01T00:00:00Z' },
    ]);
    const before = usePanda.getState().connections['agent-a']!.lastActivityAt;

    // The client's exact loadSessionInternal order (LiveAcpClient.ts).
    stubs[0]!.handlers.onSessionSwitchStage('s-a2', '/agent-a', 1);
    stubs[0]!.handlers.onReplayStart();
    stubs[0]!.handlers.onUpdate({ sessionUpdate: 'user_message', content: [{ type: 'text', text: 'history' }] });
    stubs[0]!.handlers.onUpdate({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm',
      content: { type: 'text', text: 'replied back then' },
    });
    stubs[0]!.handlers.onSessionSwitchCommit(1);

    const slot = usePanda.getState().connections['agent-a']!;
    expect(slot.sessions.find((e) => e.sessionId === 's-a2')!.updatedAt).toBe('2026-01-01T00:00:00Z');
    expect(slot.lastActivityAt).toBe(before);
    // The replayed transcript itself did land.
    expect(slot.docs['s-a2']!.turns).toHaveLength(1);
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

  it('a fresh live stamp/title beats the stale persisted one — no frozen updatedAt (#9)', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'panda.sessions:ws://x/acp',
      JSON.stringify([
        { sessionId: 's-1', cwd: '/x', title: '旧标题', updatedAt: '2026-09-04T10:00:00Z' },
      ]),
    );

    persistSessionsSnapshot(
      [{
        url: 'ws://x/acp',
        sessions: [{ sessionId: 's-1', cwd: '/x', title: '新标题', updatedAt: '2026-09-04T10:05:00Z' }],
      }],
      storage,
    );

    const persisted = JSON.parse(storage.entries.get('panda.sessions:ws://x/acp')!) as Array<{
      title: string | null;
      updatedAt: string | null;
    }>;
    expect(persisted).toEqual([
      { sessionId: 's-1', cwd: '/x', title: '新标题', updatedAt: '2026-09-04T10:05:00Z' },
    ]);
  });

  it('a null live field still falls back to the persisted value — the disk is the base layer, not the boss', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'panda.sessions:ws://x/acp',
      JSON.stringify([
        { sessionId: 's-1', cwd: '/x', title: 'agent 报过的标题', updatedAt: '2026-09-04T10:00:00Z' },
      ]),
    );

    // The live slot knows the session but has no title/stamp of its own.
    persistSessionsSnapshot(
      [{ url: 'ws://x/acp', sessions: [{ sessionId: 's-1', cwd: '/x', title: null, updatedAt: null }] }],
      storage,
    );

    const persisted = JSON.parse(storage.entries.get('panda.sessions:ws://x/acp')!) as Array<{
      title: string | null;
      updatedAt: string | null;
    }>;
    expect(persisted[0]).toMatchObject({ title: 'agent 报过的标题', updatedAt: '2026-09-04T10:00:00Z' });
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

  it('restoreEndpointSessions restores only the selected endpoint cache (relocated from useLiveSession.test.ts, #61)', () => {
    const storage = new MemoryStorage();
    const previous: SessionEntry[] = [
      { sessionId: 'from-previous-endpoint', cwd: '/previous', title: null, updatedAt: null },
    ];
    const selected: SessionEntry[] = [
      { sessionId: 'from-selected-endpoint', cwd: '/selected', title: 'Selected', updatedAt: null },
    ];
    storage.setItem('panda.sessions:ws://previous/acp', JSON.stringify(previous));
    storage.setItem('panda.sessions:ws://selected/acp', JSON.stringify(selected));

    let visible = previous;
    restoreEndpointSessions('ws://selected/acp', (sessions) => {
      visible = sessions;
    }, storage);

    expect(visible).toEqual(selected);
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

    await connectLiveConnection('agent-n', { kind: 'websocket', url: 'ws://agent-n/acp' }, { kind: 'none' });
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

    await connectLiveConnection('agent-e', { kind: 'websocket', url: 'ws://agent-e/acp' }, { kind: 'local-directory', path: '   ' });

    expect(stubs).toHaveLength(0);
    expect(usePanda.getState().connections['agent-e']).toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('workspace path are required'));
  });

  it('profile connect-time write-back preserves the workspace kind', async () => {
    const entries = stubLocalStorage();
    const p = profile('p', 'ws://p/acp', { kind: 'none' });
    saveProfiles([p]);
    const stubs = installStubClients();

    await connectLiveConnection('p', { kind: 'websocket', url: 'ws://p/acp' }, { kind: 'none' }, { profileId: 'p' });
    stubs[0]!.handlers.onConnected({ agentName: 'p-agent', protocolVersion: 1 });

    const persisted = loadProfiles();
    expect(persisted).toEqual([p]);
    expect(entries.get('panda.profiles')).toContain('"kind":"none"');
  });
});

describe('stdio targets (#121)', () => {
  const stubLocalStorage = () => {
    const entries = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
      removeItem: (key: string) => entries.delete(key),
    });
    return entries;
  };
  afterEach(() => {
    setStdioTransportFactory(null);
  });

  it('fails fast as a connection error when the host cannot spawn', async () => {
    stubLocalStorage();
    const stubs = installStubClients();

    await connectLiveConnection(
      'agent-s',
      { kind: 'stdio', command: 'node', args: 'agent.js' },
      { kind: 'local-directory', path: '/w' },
    );

    // §5.2 fail-fast: the client is never handed a transport, the slot shows
    // a connection error naming the stdio endpoint, and nothing leaks into
    // the custom-address form's websocket memory.
    expect(stubs[0]!.client.connect).not.toHaveBeenCalled();
    const conn = usePanda.getState().connections['agent-s']!.connection;
    expect(conn.status).toBe('error');
    expect(conn.url).toBe('stdio: node agent.js');
    expect(conn.error).toBeTruthy();
    expect(lastConnectionDefaults().url).toBe('');
  });

  it('spawns through the registered host factory and writes back the trimmed target', async () => {
    const entries = stubLocalStorage();
    const configs: StdioAgentConfig[] = [];
    setStdioTransportFactory((config) => {
      configs.push(config);
      return { connect: vi.fn(), disconnect: vi.fn() } as unknown as AcpTransport;
    });
    const p: AgentProfile = {
      id: 's1',
      name: 'S',
      kind: 'stdio',
      command: ' node ',
      args: ' x  y ',
      workspace: { kind: 'local-directory', path: '/w' },
      mcpServerIds: [],
    };
    saveProfiles([p]);
    const stubs = installStubClients();

    await connectLiveConnection('s1', { kind: 'stdio', command: ' node ', args: ' x  y ' }, p.workspace, { profileId: 's1' });

    // The factory received the argv-split target with the derived cwd.
    expect(configs).toEqual([{ program: 'node', args: ['x', 'y'], cwd: '/w' }]);
    expect(stubs[0]!.client.connect).toHaveBeenCalledTimes(1);
    const conn = usePanda.getState().connections['s1']!.connection;
    expect(conn.status).toBe('connecting');
    expect(conn.url).toBe('stdio: node x y');
    // The websocket prefill stayed empty (stdio never lands in URL_KEY) but
    // the cwd is remembered for the next connect.
    expect(lastConnectionDefaults().url).toBe('');
    expect(entries.get('panda.acp.cwd')).toBe('/w');

    // The same-kind write-back echoes the trimmed command/args.
    stubs[0]!.handlers.onConnected({ agentName: 's-agent', protocolVersion: 1 });
    expect(loadProfiles()).toEqual([
      { ...p, command: 'node', args: 'x y', workspace: { kind: 'local-directory', path: '/w' } },
    ]);
  });

  it('seeds offline slots for stdio profiles under their stdio endpoint', () => {
    const p: AgentProfile = {
      id: 's2',
      name: 'S2',
      kind: 'stdio',
      command: 'node',
      args: '',
      workspace: { kind: 'none' },
      mcpServerIds: [],
    };
    seedProfileSlots([p]);
    const slot = usePanda.getState().connections['s2']!;
    expect(slot.connection.status).toBe('disconnected');
    expect(slot.connection.url).toBe('stdio: node');
    expect(slot.connection.cwd).toBe(WORKSPACE_NONE_CWD);
  });
});

describe('temp slot sweep (#221: failed temp rows must not accumulate)', () => {
  it('a fresh direct dial retires the endpoint\'s earlier pure-failure temp slots', async () => {
    const stubs = installStubClients();
    const url = 'ws://dead:1/acp';
    const workspace = { kind: 'local-directory', path: '/w' } as const;

    // Two failed attempts against the same dead address.
    for (let attempt = 0; attempt < 2; attempt++) {
      await connectLiveConnection(newDirectConnectionId(), { kind: 'websocket', url }, workspace);
      stubs.at(-1)!.handlers.onDisconnected('refused');
    }

    // Each dial swept its predecessor: one error row, not a pile.
    const ids = Object.keys(usePanda.getState().connections);
    expect(ids).toHaveLength(1);
    expect(usePanda.getState().connections[ids[0]!]!.connection.status).toBe('error');
  });

  it('sweeping keeps everything that carries state — resumable slots, documents, other endpoints, profile slots', () => {
    const keep = newDirectConnectionId();
    const pureFailure = newDirectConnectionId();
    const otherEndpoint = newDirectConnectionId();
    const resumable = newDirectConnectionId();
    const withDoc = newDirectConnectionId();
    const base = emptyConnectionState().connection;
    const slot = (connection: Partial<typeof base>, extra: Partial<ConnectionState> = {}): ConnectionState => ({
      ...emptyConnectionState(),
      connection: { ...base, ...connection },
      ...extra,
    });

    usePanda.setState({
      connections: {
        [pureFailure]: slot({ status: 'error', url: 'ws://x/acp', error: 'refused' }),
        [otherEndpoint]: slot({ status: 'error', url: 'ws://other/acp', error: 'refused' }),
        // Errored after a session lived: resume is still offered (#75).
        [resumable]: slot({ status: 'error', url: 'ws://x/acp', sessionId: 's-1', error: 'dropped' }),
        // Errored, sessionless, but a retained document survives the sweep.
        [withDoc]: slot({ status: 'error', url: 'ws://x/acp', error: 'dropped' }, { docs: { 's-2': emptySession() } }),
        // An errored PROFILE slot is never a temp row.
        'profile-a': slot({ status: 'error', url: 'ws://x/acp', error: 'refused' }),
        [keep]: slot({ status: 'error', url: 'ws://x/acp', error: 'refused' }),
      },
    });

    sweepFailedDirectSlots('ws://x/acp', keep);

    const survivors = Object.keys(usePanda.getState().connections).sort();
    expect(survivors).toEqual(
      [otherEndpoint, resumable, withDoc, 'profile-a', keep].sort(),
    );
  });
});

describe('testLiveTarget (#221: handshake-then-drop probe)', () => {
  afterEach(() => {
    __setTestTransportFactory(null);
  });

  it('refuses to dial without an endpoint', async () => {
    const verdict = await testLiveTarget({ kind: 'websocket', url: '  ' }, { kind: 'none' });
    expect(verdict).toEqual({ ok: false, error: 'An endpoint is required to test' });
  });

  it('reports a stdio probe on a host that cannot spawn', async () => {
    const verdict = await testLiveTarget({ kind: 'stdio', command: 'node', args: '' }, { kind: 'none' });
    expect(verdict).toEqual({ ok: false, error: 'stdio agents require the Panda desktop app' });
  });

  it('answers a live handshake with the agent identity and leaves no store footprint', async () => {
    // An in-memory fake agent answering initialize.
    const c2s = new TransformStream<AnyMessage>();
    const s2c = new TransformStream<AnyMessage>();
    const newSessions: unknown[] = [];
    const server = agent({ name: 'probe-agent' })
      .onRequest(methods.agent.initialize, () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'probe-agent', title: 'Probe Agent', version: '0.0.0' },
        agentCapabilities: { sessionCapabilities: { list: {} } },
      }))
      .onRequest(methods.agent.session.list, () => ({ sessions: [] }))
      .onRequest(methods.agent.session.new, (ctx) => {
        newSessions.push(ctx.params);
        return { sessionId: 'never' };
      })
      .connect({ writable: s2c.writable, readable: c2s.readable });
    __setTestTransportFactory(() => new StreamTransport({ writable: c2s.writable, readable: s2c.readable }));

    const verdict = await testLiveTarget({ kind: 'websocket', url: 'ws://probe:1/acp' }, { kind: 'none' });

    expect(verdict).toEqual({ ok: true, agentName: 'Probe Agent', protocolVersion: PROTOCOL_VERSION });
    // A probe never establishes a session and never touches the store.
    expect(newSessions).toEqual([]);
    expect(usePanda.getState().connections).toEqual({});
    server.close();
  });

  it('carries a refused handshake through the connect-failure copy (#217)', async () => {
    // A transport whose stream acquisition dies — the shape a refused dial
    // takes below the WebSocket seam.
    const failing: AcpTransport = {
      connect: () => Promise.reject(new Error('boom')),
      disconnect: () => {},
    };
    __setTestTransportFactory(() => failing);
    const verdict = await testLiveTarget({ kind: 'websocket', url: 'ws://dead:9/acp' }, { kind: 'none' });
    expect(verdict).toEqual({ ok: false, error: 'Connection failed: boom' });
  });

  it('settles even when the handshake hangs on a dead link (refused dial, #217 shape)', async () => {
    // Pre-handshake close: reads hit EOF immediately (connection.closed
    // settles) but initialize never answers — connect() stays suspended,
    // exactly like a browser WebSocket refused before it opened (browsers
    // collapse every handshake failure to close code 1006). The probe must
    // resolve through the onDisconnected attribution anyway.
    const preHandshakeClose: AcpTransport = {
      closed: Promise.resolve(1006),
      connect: () =>
        Promise.resolve({
          readable: new ReadableStream({ start: (controller) => controller.close() }),
          writable: new WritableStream(),
        }),
      disconnect: () => {},
    };
    __setTestTransportFactory(() => preHandshakeClose);
    const verdict = await testLiveTarget({ kind: 'websocket', url: 'ws://refused:1/acp' }, { kind: 'none' });
    expect(verdict).toEqual({
      ok: false,
      error: 'Could not connect — make sure the agent is running at this address and the path points at its ACP endpoint',
    });
  });
});
