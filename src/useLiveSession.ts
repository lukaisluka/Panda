import { useEffect, useMemo } from 'react';
import { usePanda } from './store';
import type { SessionEntry } from './store';
import {
  authenticateLiveConnection,
  cancelLiveTurn,
  connectLiveConnection,
  deleteLiveSession,
  disconnectLiveConnection,
  foregroundConnection,
  isDirectConnectionId,
  logoutLiveConnection,
  newDirectConnectionId,
  newLiveSession,
  openLiveSession,
  persistSessionsSnapshot,
  seedProfileSlots,
  removeLiveConnection,
  openLiveElicitationUrl,
  resolveLiveElicitation,
  resolveLivePermission,
  sendLive,
  setLiveConfigOption,
  setLiveMode,
} from './liveConnections';
import type { AgentProfile } from './profiles';
import { cwdToWorkspace, type Workspace } from './workspace';
import type { ForegroundSessionController } from './session-controller';

/** Options for reconnecting the foreground slot. */
export type ReconnectOptions = {
  /** Resume the slot's retained session (transcript kept) instead of a fresh one. */
  resume?: boolean;
  /** Form-edited endpoint values; omitted ones fall back to the slot's. */
  url?: string;
  workspace?: Workspace;
};

/**
 * React facade over the live connection manager (issue #21): stable
 * callbacks that resolve the foreground connection at call time, plus the
 * one genuinely reactive concern — persisting every connection's session
 * list per endpoint. All driver logic lives in `liveConnections.ts`.
 */
export function useLiveSession() {
  // The persisted projection is serialized into a string: a selector
  // returning fresh objects would loop useSyncExternalStore (getSnapshot
  // must be identity-stable), and a string only changes when a slot's
  // endpoint or session list actually changed — streaming document updates
  // never rewrite localStorage.
  const sessionListsSnapshot = usePanda((s) =>
    JSON.stringify(
      Object.values(s.connections).map((slot) => [slot.connection.url, slot.sessions] as const),
    ),
  );
  useEffect(() => {
    const lists = JSON.parse(sessionListsSnapshot) as Array<[string | null, SessionEntry[]]>;
    persistSessionsSnapshot(lists.map(([url, sessions]) => ({ url, sessions })));
  }, [sessionListsSnapshot]);

  return useMemo<LiveSessionFacade>(
    () => ({
      connectDirect: (url: string, workspace: Workspace) => connectLiveConnection(newDirectConnectionId(), url, workspace),
      connectProfile: (profile: AgentProfile) =>
        connectLiveConnection(profile.id, profile.url, profile.workspace, { profileId: profile.id }),
      reconnectForeground: (opts?: ReconnectOptions) => {
        const state = usePanda.getState();
        const connectionId = state.activeConnectionId;
        if (connectionId === null) {
          console.warn('[panda/acp] reconnect ignored: no foreground connection');
          return;
        }
        const slot = state.connections[connectionId];
        const url = opts?.url?.trim() || slot?.connection.url;
        // The slot remembers the derived cwd it last used; `/` reads back as
        // 无工作区 (ADR 0005's accepted equivalence).
        const workspace = opts?.workspace ?? (slot?.connection.cwd != null ? cwdToWorkspace(slot.connection.cwd) : null);
        if (!url || !workspace) {
          console.warn(`[panda/acp] reconnect ignored: slot "${connectionId}" has no remembered url/workspace`);
          return;
        }
        const profileId = isDirectConnectionId(connectionId) ? null : connectionId;
        void connectLiveConnection(connectionId, url, workspace, { resume: opts?.resume, profileId });
      },
      disconnect: disconnectLiveConnection,
      remove: removeLiveConnection,
      seedProfileSlots,
      foreground: foregroundConnection,
      authenticate: (methodId: string) => authenticateLiveConnection(methodId),
      logout: () => logoutLiveConnection(),
      openSession: openLiveSession,
      send: (content) => sendLive(content),
      resolvePermission: (toolCallId, kind) => resolveLivePermission(toolCallId, kind),
      resolveElicitation: (id, response) => resolveLiveElicitation(id, response),
      openElicitationUrl: (id) => openLiveElicitationUrl(id),
      cancel: cancelLiveTurn,
      setMode: (modeId) => setLiveMode(modeId),
      setConfigOption: (configId, value) => setLiveConfigOption(configId, value),
      newSession: (cwd) => newLiveSession(cwd),
      deleteSession: (connectionId, sessionId) => deleteLiveSession(connectionId, sessionId),
    }),
    [],
  );
}

/**
 * The live driver's full surface (#51): the foreground session controller
 * (the seam it shares with the demo replay) plus the connection-level
 * operations only a live connection can have. Handwritten so a renamed
 * member fails here, at the hook, instead of at the call site.
 */
export interface LiveSessionFacade extends ForegroundSessionController {
  /** 临时直连: a fresh anonymous slot that dies with its disconnect. */
  connectDirect: (url: string, workspace: Workspace) => void;
  /** Connects an Agent 配置's slot with its stored url/workspace. */
  connectProfile: (profile: AgentProfile) => void;
  /**
   * Reconnects the foreground slot. Form-edited url/workspace override the
   * slot's remembered values and — for a profile slot — are written back
   * to the 配置 on a successful connect (配置编辑静默生效于下次连接).
   */
  reconnectForeground: (opts?: ReconnectOptions) => void;
  disconnect: typeof disconnectLiveConnection;
  remove: typeof removeLiveConnection;
  seedProfileSlots: typeof seedProfileSlots;
  foreground: typeof foregroundConnection;
  /** v1 auth recovery: run a login method on the foreground connection. */
  authenticate: (methodId: string) => void;
  /** v1 `logout` on the foreground connection (gated by auth.logout). */
  logout: () => void;
  openSession: typeof openLiveSession;
  cancel: typeof cancelLiveTurn;
  newSession: (cwd: string) => void;
  deleteSession: (connectionId: string, sessionId: string) => void;
}
