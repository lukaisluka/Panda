import { useCallback, useEffect, useRef } from 'react';
import { createWebSocketStream } from '@agentclientprotocol/sdk/experimental/ws-client';
import { LiveAcpClient } from './acp/LiveAcpClient';
import type { PermissionOptionKind } from './protocol/types';
import { usePanda, type SessionEntry } from './store';

/**
 * Phase 1+2 session driver: wires the live ACP client into the store exactly
 * the way the replay driver is wired (handlers -> store actions). Panda only
 * connects to an already-running ACP service over WebSocket — it never spawns
 * or manages the agent process.
 *
 * Session bookkeeping: the sidebar list merges server `session/list` entries
 * with locally-created ones and persists per-service to localStorage.
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

function loadPersistedSessions(url: string): SessionEntry[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY_PREFIX + url);
    return raw ? (JSON.parse(raw) as SessionEntry[]) : [];
  } catch (err) {
    console.warn('[panda] could not read persisted sessions', err);
    return [];
  }
}

function persistSessions(url: string, sessions: SessionEntry[]): void {
  try {
    localStorage.setItem(SESSIONS_KEY_PREFIX + url, JSON.stringify(sessions.slice(-PERSIST_LIMIT)));
  } catch (err) {
    console.warn('[panda] could not persist sessions', err);
  }
}

export function useLiveSession() {
  // Lazily created once, mirroring useReplaySession's driver wiring.
  const clientRef = useRef<LiveAcpClient | null>(null);
  if (clientRef.current === null) {
    clientRef.current = new LiveAcpClient({
      onUpdate: (update) => usePanda.getState().update(update),
      onStatus: (status) => usePanda.getState().setStatus(status),
      onPermission: (request) => usePanda.getState().setPermission(request),
      onConnected: (info) =>
        usePanda.getState().setConnection({
          status: 'connected',
          agentName: info.agentName,
          protocolVersion: info.protocolVersion,
          error: null,
        }),
      onSessionId: (sessionId, cwd) => {
        const store = usePanda.getState();
        store.setConnection({ sessionId });
        store.upsertSession({ sessionId, cwd });
      },
      // An unexpected disconnect keeps the session id so the panel can offer
      // "reconnect and resume"; a clean user disconnect clears it.
      onDisconnected: (reason) =>
        usePanda
          .getState()
          .setConnection(
            reason
              ? { status: 'error', error: reason }
              : { status: 'disconnected', error: null, sessionId: null },
          ),
      onCapabilities: (caps) =>
        usePanda.getState().setCapabilities({
          loadSession: caps.loadSession,
          list: caps.list,
          resume: caps.resume,
          delete: caps.delete,
        }),
      onSessions: (entries) => usePanda.getState().mergeSessions(entries),
      onSessionInfo: (sessionId, info) => usePanda.getState().patchSession(sessionId, info),
      onReplayStart: () => usePanda.getState().resetDocument(),
      onSessionDeleted: (sessionId) => usePanda.getState().removeSession(sessionId),
    });
  }
  const acpClient = clientRef.current;

  const connect = useCallback(
    async (url: string, cwd: string, opts?: { resume?: boolean }) => {
      const trimmedUrl = url.trim();
      const trimmedCwd = cwd.trim();
      if (!trimmedUrl || !trimmedCwd) {
        console.warn('[panda/acp] connect ignored: url and cwd are required');
        return;
      }
      remember(URL_KEY, trimmedUrl);
      remember(CWD_KEY, trimmedCwd);
      const store = usePanda.getState();
      const resumeSessionId = opts?.resume ? store.connection.sessionId : null;
      if (!resumeSessionId) store.resetDocument();
      store.setMode('live');
      store.setConnection({
        status: 'connecting',
        url: trimmedUrl,
        cwd: trimmedCwd,
        error: null,
        agentName: null,
        protocolVersion: null,
        sessionId: resumeSessionId,
      });
      // Seed the sidebar with sessions remembered for this service; the
      // server list (if any) merges on top.
      store.mergeSessions(loadPersistedSessions(trimmedUrl));
      await acpClient.connect(
        createWebSocketStream(trimmedUrl),
        trimmedCwd,
        resumeSessionId ? { sessionId: resumeSessionId } : undefined,
      );
    },
    [acpClient],
  );

  const disconnect = useCallback(() => {
    acpClient.disconnect();
  }, [acpClient]);

  const newSession = useCallback(
    async (cwd: string) => {
      const trimmedCwd = cwd.trim();
      if (!trimmedCwd) {
        console.warn('[panda/acp] newSession ignored: cwd is required');
        return;
      }
      remember(CWD_KEY, trimmedCwd);
      usePanda.getState().resetDocument();
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

  const send = useCallback((text: string) => acpClient.send(text), [acpClient]);

  const resolvePermission = useCallback(
    (kind: PermissionOptionKind) => acpClient.resolvePermission(kind),
    [acpClient],
  );

  const cancel = useCallback(() => acpClient.cancel(), [acpClient]);

  // Persist the session list per service endpoint.
  const connectionUrl = usePanda((s) => s.connection.url);
  const sessions = usePanda((s) => s.sessions);
  useEffect(() => {
    if (connectionUrl) persistSessions(connectionUrl, sessions);
  }, [connectionUrl, sessions]);

  return {
    connect,
    disconnect,
    newSession,
    loadSession,
    deleteSession,
    send,
    resolvePermission,
    cancel,
  };
}