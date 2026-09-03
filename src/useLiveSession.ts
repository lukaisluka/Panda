import { useCallback, useEffect, useRef } from 'react';
import { LiveAcpClient } from './acp/LiveAcpClient';
import { createBrowserWebSocketStream } from './acp/browserWebSocketStream';
import type { AcpContentBlock, PermissionOptionKind } from './protocol/types';
import {
  connectionStorePort,
  useActiveConnection,
  useActiveSessions,
  usePanda,
  type ConnectionStorePort,
  type SessionEntry,
  type SessionSwitchSnapshot,
} from './store';
import { updateProfileFields, type AgentProfile } from './profiles';

/**
 * Phase 1+2 session driver: wires the live ACP client into the store exactly
 * the way the replay driver is wired (handlers -> store actions). Panda only
 * connects to an already-running ACP service over WebSocket — it never spawns
 * or manages the agent process.
 *
 * Session bookkeeping: the sidebar list merges server `session/list` entries
 * with locally-created ones and persists per-service to localStorage.
 * Agent 配置 (issue #2): a connect carried under a profile id writes the
 * trimmed url/cwd back into that profile once the connection succeeds.
 */

const URL_KEY = 'panda.acp.url';
const CWD_KEY = 'panda.acp.cwd';
const SESSIONS_KEY_PREFIX = 'panda.sessions:';
const PERSIST_LIMIT = 50;

/** Remembers the endpoint between reloads; persistence is best-effort. */
function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    console.warn(`[panda] could not persist ${key}`, err);
  }
}

/** Last-used endpoint values for prefilling the connect form. */
export function lastConnectionDefaults(): { url: string; cwd: string } {
  return {
    url: localStorage.getItem(URL_KEY) ?? '',
    cwd: localStorage.getItem(CWD_KEY) ?? '',
  };
}

/** Live-connect options; `profileId` routes the on-success write-back. */
export type ConnectOptions = { resume?: boolean; profileId?: string | null };

export interface SessionStorage {
  getItem(key: string): string | null;
}

function loadPersistedSessions(url: string, storage: SessionStorage = localStorage): SessionEntry[] {
  try {
    const raw = storage.getItem(SESSIONS_KEY_PREFIX + url);
    return raw ? (JSON.parse(raw) as SessionEntry[]) : [];
  } catch (err) {
    console.warn('[panda] could not read persisted sessions', err);
    return [];
  }
}

/**
 * Restores the remembered sidebar entries for one endpoint. This is a
 * replacement, never a merge: the visible list belongs to one connection
 * target at a time, so entries from the previously selected endpoint must not
 * bleed into it.
 */
export function restoreEndpointSessions(
  url: string,
  replaceSessions: (entries: SessionEntry[]) => void,
  storage: SessionStorage = localStorage,
): void {
  replaceSessions(loadPersistedSessions(url, storage));
}

function persistSessions(url: string, sessions: SessionEntry[]): void {
  try {
    localStorage.setItem(SESSIONS_KEY_PREFIX + url, JSON.stringify(sessions.slice(-PERSIST_LIMIT)));
  } catch (err) {
    console.warn('[panda] could not persist sessions', err);
  }
}

/** The one live connection slot; stable across reconnects so its documents (and thus a resumable transcript) survive. */
const LIVE_CONNECTION_ID = 'live';

export function useLiveSession() {
  // Connection-scoped store port: handlers never touch global fields (#16).
  const portRef = useRef<ConnectionStorePort | null>(null);
  if (portRef.current === null) portRef.current = connectionStorePort(LIVE_CONNECTION_ID);
  const port = portRef.current;
  // Snapshot of the in-flight session switch (issue #17) — captured at stage,
  // consumed by exactly one commit or rollback.
  const stagedSwitchRef = useRef<SessionSwitchSnapshot | null>(null);
  // Lazily created once, mirroring useReplaySession's driver wiring.
  const clientRef = useRef<LiveAcpClient | null>(null);
  // Profile targeted by the in-flight connect — consumed on success
  // (write-back) or dropped on any disconnect (no write-back on failure).
  const pendingProfileRef = useRef<{ id: string; url: string; cwd: string } | null>(null);
  if (clientRef.current === null) {
    clientRef.current = new LiveAcpClient({
      onUpdate: (update) => port.update(update),
      onStatus: (status) => port.setStatus(status),
      onPermission: (request) => port.setPermission(request),
      onConnected: (info) => {
        port.setConnection({
          status: 'connected',
          agentName: info.agentName,
          protocolVersion: info.protocolVersion,
          error: null,
        });
        // "默认工作目录" = what the last successful connect used (issue #2).
        const pending = pendingProfileRef.current;
        if (pending) updateProfileFields(pending.id, { url: pending.url, cwd: pending.cwd });
        pendingProfileRef.current = null;
      },
      onSessionId: (sessionId, cwd) => port.adoptSession(sessionId, cwd),
      // An unexpected disconnect keeps the session id so the panel can offer
      // "reconnect and resume"; a clean user disconnect clears it. Either way
      // a failed connect must not write its edits back into the profile.
      onDisconnected: (reason) => {
        pendingProfileRef.current = null;
        port.setConnection(
          reason
            ? { status: 'error', error: reason }
            : { status: 'disconnected', error: null, sessionId: null },
        );
      },
      onCapabilities: (caps) =>
        port.setCapabilities({
          image: caps.image,
          loadSession: caps.loadSession,
          list: caps.list,
          resume: caps.resume,
          delete: caps.delete,
        }),
      onSessions: (entries) => port.mergeSessions(entries),
      onSessionInfo: (sessionId, info) => port.patchSession(sessionId, info),
      onReplayStart: () => port.resetDocument(),
      onSessionDeleted: (sessionId) => port.removeSession(sessionId),
      onSessionSwitchStage: (sessionId, cwd) => {
        stagedSwitchRef.current = port.stageSession(sessionId, cwd);
      },
      onSessionSwitchCommit: () => {
        stagedSwitchRef.current = null;
        port.commitStagedSession();
      },
      onSessionSwitchRollback: (reason) => {
        const snapshot = stagedSwitchRef.current;
        stagedSwitchRef.current = null;
        if (!snapshot) {
          // The client's transaction state machine drifted from the driver's
          // — fail loudly instead of silently skipping the restore.
          console.error('[panda/acp] session switch rollback without a staged snapshot');
          return;
        }
        port.rollbackStagedSession(snapshot);
        // Surface the failure on a live connection only: after a disconnect
        // (reason=null already reported) a stale error banner must not linger.
        if (usePanda.getState().connections[LIVE_CONNECTION_ID]?.connection.status === 'connected') {
          port.setConnection({ error: `切换会话失败: ${reason}` });
        }
      },
    });
  }
  const acpClient = clientRef.current;

  const connect = useCallback(
    async (url: string, cwd: string, opts?: ConnectOptions) => {
      const trimmedUrl = url.trim();
      const trimmedCwd = cwd.trim();
      if (!trimmedUrl || !trimmedCwd) {
        console.warn('[panda/acp] connect ignored: url and cwd are required');
        return;
      }
      remember(URL_KEY, trimmedUrl);
      remember(CWD_KEY, trimmedCwd);
      pendingProfileRef.current = opts?.profileId
        ? { id: opts.profileId, url: trimmedUrl, cwd: trimmedCwd }
        : null;
      usePanda.getState().ensureConnection(LIVE_CONNECTION_ID);
      const resumeSessionId = opts?.resume
        ? usePanda.getState().connections[LIVE_CONNECTION_ID]?.connection.sessionId ?? null
        : null;
      // Fresh connect: drop a stale permission card; the previous session's
      // document stays in the slot (the pointer moves once a session adopts).
      if (!resumeSessionId) port.setPermission(null);
      usePanda.getState().setMode('live');
      port.setConnection({
        status: 'connecting',
        url: trimmedUrl,
        cwd: trimmedCwd,
        error: null,
        agentName: null,
        protocolVersion: null,
        sessionId: resumeSessionId,
      });
      // Seed the sidebar with sessions remembered for this service; the
      // server list (if any) merges on top. A new endpoint replaces the old
      // endpoint's visible list rather than combining unrelated histories.
      restoreEndpointSessions(trimmedUrl, port.replaceSessions);
      await acpClient.connect(
        createBrowserWebSocketStream(trimmedUrl),
        trimmedCwd,
        resumeSessionId ? { sessionId: resumeSessionId } : undefined,
      );
    },
    [acpClient],
  );

  const disconnect = useCallback(() => {
    acpClient.disconnect();
  }, [acpClient]);

  /**
   * Previews a saved Agent 配置 while disconnected. In live mode this abandons
   * a resumable session from the previous endpoint and shows only the new
   * endpoint's remembered sessions before the user connects.
   */
  const selectProfile = useCallback((profile: AgentProfile) => {
    const url = profile.url.trim();
    const cwd = profile.cwd.trim();
    if (!url || !cwd) {
      console.error(`[panda/profiles] selected profile ${profile.id} has an empty url or cwd`);
      return;
    }
    restoreEndpointSessions(url, port.replaceSessions);
    if (usePanda.getState().mode !== 'live') return;

    port.resetDocument();
    port.setCapabilities({ image: false, loadSession: false, list: false, resume: false, delete: false });
    port.setConnection({
      status: 'disconnected',
      url,
      cwd,
      agentName: null,
      protocolVersion: null,
      sessionId: null,
      error: null,
    });
  }, []);

  const newSession = useCallback(
    async (cwd: string) => {
      const trimmedCwd = cwd.trim();
      if (!trimmedCwd) {
        console.warn('[panda/acp] newSession ignored: cwd is required');
        return;
      }
      remember(CWD_KEY, trimmedCwd);
      // The new session adopts a fresh document; the old one is retained.
      port.setPermission(null);
      await acpClient.newSession(trimmedCwd);
    },
    [acpClient],
  );

  /** Switches to another known session (requires loadSession capability). */
  const loadSession = useCallback(
    (sessionId: string, cwd: string) => acpClient.loadSession(sessionId, cwd),
    [acpClient],
  );

  const deleteSession = useCallback(
    (sessionId: string) => acpClient.deleteSession(sessionId),
    [acpClient],
  );

  const send = useCallback(
    (content: AcpContentBlock[]) => acpClient.send(content),
    [acpClient],
  );

  const resolvePermission = useCallback(
    (kind: PermissionOptionKind) => acpClient.resolvePermission(kind),
    [acpClient],
  );

  const cancel = useCallback(() => acpClient.cancel(), [acpClient]);

  // Persist the session list per service endpoint.
  const connectionUrl = useActiveConnection().url;
  const sessions = useActiveSessions();
  useEffect(() => {
    if (connectionUrl) persistSessions(connectionUrl, sessions);
  }, [connectionUrl, sessions]);

  return {
    connect,
    disconnect,
    selectProfile,
    newSession,
    loadSession,
    deleteSession,
    send,
    resolvePermission,
    cancel,
  };
}
