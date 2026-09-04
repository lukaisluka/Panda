import { useEffect, useMemo } from 'react';
import { usePanda } from './store';
import type { SessionEntry } from './store';
import {
  cancelLiveTurn,
  connectLiveConnection,
  deleteLiveSession,
  disconnectLiveConnection,
  foregroundConnection,
  isDirectConnectionId,
  newDirectConnectionId,
  newLiveSession,
  openLiveSession,
  persistSessionsSnapshot,
  previewProfileConnection,
  removeLiveConnection,
  resolveLivePermission,
  sendLive,
} from './liveConnections';
import type { AgentProfile } from './profiles';
import type { AcpContentBlock, PermissionOptionKind } from './protocol/types';

/** Options for reconnecting the foreground slot. */
export type ReconnectOptions = {
  /** Resume the slot's retained session (transcript kept) instead of a fresh one. */
  resume?: boolean;
  /** Form-edited endpoint values; omitted/empty ones fall back to the slot's. */
  url?: string;
  cwd?: string;
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

  return useMemo(
    () => ({
      /** 临时直连: a fresh anonymous slot that dies with its disconnect. */
      connectDirect: (url: string, cwd: string) => connectLiveConnection(newDirectConnectionId(), url, cwd),
      /** Connects an Agent 配置's slot with its stored url/cwd. */
      connectProfile: (profile: AgentProfile) =>
        connectLiveConnection(profile.id, profile.url, profile.cwd, { profileId: profile.id }),
      /**
       * Reconnects the foreground slot. Form-edited url/cwd override the
       * slot's remembered values and — for a profile slot — are written back
       * to the 配置 on a successful connect (配置编辑静默生效于下次连接).
       */
      reconnectForeground: (opts?: ReconnectOptions) => {
        const state = usePanda.getState();
        const connectionId = state.activeConnectionId;
        if (connectionId === null) {
          console.warn('[panda/acp] reconnect ignored: no foreground connection');
          return;
        }
        const slot = state.connections[connectionId];
        const url = opts?.url?.trim() || slot?.connection.url;
        const cwd = opts?.cwd?.trim() || slot?.connection.cwd;
        if (!url || !cwd) {
          console.warn(`[panda/acp] reconnect ignored: slot "${connectionId}" has no remembered url/cwd`);
          return;
        }
        const profileId = isDirectConnectionId(connectionId) ? null : connectionId;
        void connectLiveConnection(connectionId, url, cwd, { resume: opts?.resume, profileId });
      },
      disconnect: disconnectLiveConnection,
      remove: removeLiveConnection,
      previewProfile: previewProfileConnection,
      foreground: foregroundConnection,
      openSession: openLiveSession,
      send: (content: AcpContentBlock[]) => sendLive(content),
      resolvePermission: (toolCallId: string, kind: PermissionOptionKind) => resolveLivePermission(toolCallId, kind),
      cancel: cancelLiveTurn,
      newSession: (cwd: string) => newLiveSession(cwd),
      deleteSession: (connectionId: string, sessionId: string) => deleteLiveSession(connectionId, sessionId),
    }),
    [],
  );
}

export type LiveSessionFacade = ReturnType<typeof useLiveSession>;
