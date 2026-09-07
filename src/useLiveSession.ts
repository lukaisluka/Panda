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
  logoutLiveConnection,
  newDirectConnectionId,
  newLiveSession,
  openLiveSession,
  persistSessionsSnapshot,
  reconnectLiveConnection,
  seedProfileSlots,
  removeLiveConnection,
  openLiveElicitationUrl,
  resolveLiveElicitation,
  resolveLivePermission,
  sendLive,
  setLiveConfigOption,
  setLiveMode,
  type ReconnectOptions,
} from './liveConnections';

export type { ReconnectOptions };
import { profileToLiveTarget, type AgentProfile } from './profiles';
import type { Workspace } from './workspace';
import type { ForegroundSessionController } from './session-controller';

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
      connectDirect: (url: string, workspace: Workspace) =>
        connectLiveConnection(newDirectConnectionId(), { kind: 'websocket', url }, workspace),
      connectProfile: (profile: AgentProfile) =>
        connectLiveConnection(profile.id, profileToLiveTarget(profile), profile.workspace, { profileId: profile.id }),
      reconnectForeground: (opts?: ReconnectOptions) =>
        // Row-level actions name their slot (bug hunt #1); the foreground is
        // only the default. Target resolution lives in the manager (testable).
        reconnectLiveConnection(
          opts?.connectionId ?? usePanda.getState().activeConnectionId,
          opts,
        ),
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
      newSession: (cwd, connectionId) => newLiveSession(cwd, connectionId),
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
   * Reconnects a slot — `opts.connectionId` names the row-level target
   * (error-block buttons); the foreground is the default. Form-edited
   * url/workspace override the slot's remembered values and — for a profile
   * slot — are written back to the 配置 on a successful connect
   * (配置编辑静默生效于下次连接).
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
  /** Creates a session; the optional id names the target connection (the
   * row the user clicked), foreground follows it (bug hunt #5). */
  newSession: (cwd: string, connectionId?: string) => void;
  deleteSession: (connectionId: string, sessionId: string) => void;
}
