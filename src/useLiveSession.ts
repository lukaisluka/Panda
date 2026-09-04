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
  openLiveElicitationUrl,
  resolveLiveElicitation,
  resolveLivePermission,
  sendLive,
  setLiveConfigOption,
  setLiveMode,
} from './liveConnections';
import type { AgentProfile } from './profiles';
import { cwdToWorkspace, type Workspace } from './workspace';
import type { AcpContentBlock, ElicitationResponse, PermissionOptionKind } from './protocol/types';

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

  return useMemo(
    () => ({
      /** 临时直连: a fresh anonymous slot that dies with its disconnect. */
      connectDirect: (url: string, workspace: Workspace) => connectLiveConnection(newDirectConnectionId(), url, workspace),
      /** Connects an Agent 配置's slot with its stored url/workspace. */
      connectProfile: (profile: AgentProfile) =>
        connectLiveConnection(profile.id, profile.url, profile.workspace, { profileId: profile.id }),
      /**
       * Reconnects the foreground slot. Form-edited url/workspace override the
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
      previewProfile: previewProfileConnection,
      foreground: foregroundConnection,
      openSession: openLiveSession,
      send: (content: AcpContentBlock[]) => sendLive(content),
      resolvePermission: (toolCallId: string, kind: PermissionOptionKind) => resolveLivePermission(toolCallId, kind),
      resolveElicitation: (id: string, response: ElicitationResponse) => resolveLiveElicitation(id, response),
      openElicitationUrl: (id: string) => openLiveElicitationUrl(id),
      cancel: cancelLiveTurn,
      setMode: (modeId: string) => setLiveMode(modeId),
      setConfigOption: (configId: string, value: string | boolean) => setLiveConfigOption(configId, value),
      newSession: (cwd: string) => newLiveSession(cwd),
      deleteSession: (connectionId: string, sessionId: string) => deleteLiveSession(connectionId, sessionId),
    }),
    [],
  );
}

export type LiveSessionFacade = ReturnType<typeof useLiveSession>;
