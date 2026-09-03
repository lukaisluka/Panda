import { create } from 'zustand';
import { applyUpdate, emptySession } from './protocol/reducer';
import type {
  AcpSessionUpdate,
  SessionDocument,
  SessionStatus,
} from './protocol/types';

/**
 * Store keyed by (connectionId, sessionId) — ADR 0002's prerequisite for
 * parallel agent connections. Each connection slot owns its documents, so an
 * inactive session's transcript survives switching. `applyUpdate` semantics
 * are unchanged; the scope is decided by the caller — session drivers write
 * through a `connectionStorePort`, never the global fields.
 *
 * The store never invents document state: all document mutation flows through
 * `applyUpdate`, and connection/session bookkeeping is set by the drivers.
 */

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type ConnectionInfo = {
  status: ConnectionStatus;
  /** WebSocket endpoint of the ACP service, remembered for reconnects. */
  url: string | null;
  /** Working directory passed to session/new for this connection. */
  cwd: string | null;
  /** Display name from the agent's `initialize` response (title ?? name). */
  agentName: string | null;
  /** Protocol version negotiated during `initialize`. */
  protocolVersion: number | null;
  /** Session id returned by `session/new`, null while no session exists. */
  sessionId: string | null;
  /** Last connection failure, shown in the status bar. */
  error: string | null;
};

/** One conversation known to the sidebar. Server-listed or locally created. */
export type SessionEntry = {
  sessionId: string;
  cwd: string;
  title: string | null;
  /** ISO 8601 last-activity timestamp from the agent, if reported. */
  updatedAt: string | null;
};

/** What the current agent advertised at initialize (v1 capability gates). */
export type AgentCapabilityInfo = {
  image: boolean;
  loadSession: boolean;
  list: boolean;
  resume: boolean;
  delete: boolean;
};

export type SessionMode = 'demo' | 'live';

/** Everything one agent connection owns. Documents are keyed by sessionId. */
export type ConnectionState = {
  connection: ConnectionInfo;
  capabilities: AgentCapabilityInfo;
  /** Sidebar list — belongs to this connection's endpoint only. */
  sessions: SessionEntry[];
  docs: Record<string, SessionDocument>;
  /**
   * A transactional session switch in flight (issue #17): the target session
   * is staged and its history replay is loading. Null once committed or
   * rolled back — the settled state is `connection.sessionId` +
   * `activeSessionId`, which only a commit may move.
   */
  switching: { sessionId: string } | null;
};

/**
 * Snapshot taken before a transactional session switch (issue #17) — what
 * `rollbackStagedSession` restores when `session/load` fails: the routed
 * session, the target's document (the thing the replay reset destroys —
 * permissions included, they live in the document per #18) and the settled
 * `connection.sessionId`. The sidebar entry is deliberately kept — stage's
 * metadata upsert survives (title and updatedAt retention is the point).
 * Captured before the replay reset runs.
 */
export type SessionSwitchSnapshot = {
  /** The switch's target; identifies the document rollback writes back. */
  targetSessionId: string;
  /** The session the port fed before the switch; null = none adopted. */
  prevSessionId: string | null;
  /** The target's document before the replay reset it; null = it didn't exist. */
  targetDoc: SessionDocument | null;
  /** connection.sessionId before the switch. */
  connectionSessionId: string | null;
};

/** A session as locally known — sparse fields merge with existing knowledge. */
export type SessionUpsert = {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
};

interface PandaState {
  mode: SessionMode;
  connections: Record<string, ConnectionState>;
  activeConnectionId: string | null;
  /** The session whose document the UI renders; drivers move this pointer. */
  activeSessionId: string | null;
  setMode(mode: SessionMode): void;
  /**
   * Creates the slot if missing (existing documents survive — reconnects keep
   * their transcript) and makes it the active connection.
   */
  ensureConnection(connectionId: string): void;
  /** Drops a slot entirely; clears the pointers if it was active. */
  closeConnection(connectionId: string): void;
}

const initialConnection: ConnectionInfo = {
  status: 'disconnected',
  url: null,
  cwd: null,
  agentName: null,
  protocolVersion: null,
  sessionId: null,
  error: null,
};

const initialCapabilities: AgentCapabilityInfo = {
  image: false,
  loadSession: false,
  list: false,
  resume: false,
  delete: false,
};

export function emptyConnectionState(): ConnectionState {
  return {
    connection: initialConnection,
    capabilities: initialCapabilities,
    sessions: [],
    docs: {},
    switching: null,
  };
}

function upsertEntries(existing: SessionEntry[], incoming: SessionEntry[]): SessionEntry[] {
  const byId = new Map(existing.map((entry) => [entry.sessionId, entry]));
  for (const entry of incoming) byId.set(entry.sessionId, entry);
  return [...byId.values()];
}

/** Immutable patch of one connection slot; unknown ids fail loudly, not silently. */
function patchConnectionState(
  s: PandaState,
  connectionId: string,
  patch: (state: ConnectionState) => Partial<ConnectionState>,
): Partial<PandaState> | null {
  const existing = s.connections[connectionId];
  if (!existing) {
    console.warn(`[store] update for unknown connection "${connectionId}" — ignored`);
    return null;
  }
  return { connections: { ...s.connections, [connectionId]: { ...existing, ...patch(existing) } } };
}

export const usePanda = create<PandaState>((set) => ({
  mode: 'demo',
  connections: {},
  activeConnectionId: null,
  activeSessionId: null,
  setMode: (mode) => set({ mode }),
  ensureConnection: (connectionId) =>
    set((s) => ({
      connections: s.connections[connectionId]
        ? s.connections
        : { ...s.connections, [connectionId]: emptyConnectionState() },
      activeConnectionId: connectionId,
    })),
  closeConnection: (connectionId) =>
    set((s) => {
      const connections = { ...s.connections };
      delete connections[connectionId];
      return {
        connections,
        ...(s.activeConnectionId === connectionId
          ? { activeConnectionId: null, activeSessionId: null }
          : {}),
      };
    }),
}));

// ---------------------------------------------------------------------------
// Driver-facing scoped write port
// ---------------------------------------------------------------------------

/**
 * The write surface one session driver (live client or replay) may touch.
 * Everything is scoped to its own connection slot and the session it last
 * adopted, so driver handlers never write global fields directly (issue #16
 * acceptance 3). In single-connection mode the adopting connection is always
 * the active one; #21 will scope the UI pointer per connection.
 */
export type ConnectionStorePort = {
  /**
   * Adopts a session: ensures its document exists (retained when revisited —
   * a `session/load` replay resets it via `resetDocument` after adopting) and
   * points the UI at it.
   */
  adoptSession(sessionId: string, cwd: string): void;
  update(update: AcpSessionUpdate): void;
  setStatus(status: SessionStatus): void;
  setConnection(patch: Partial<ConnectionInfo>): void;
  /** Clears the adopted session's document (permissions live inside it). */
  resetDocument(): void;
  setCapabilities(caps: AgentCapabilityInfo): void;
  /** Upserts entries by sessionId; locally-known sessions are preserved. */
  mergeSessions(entries: SessionEntry[]): void;
  /** Replaces the visible list when the selected connection target changes. */
  replaceSessions(entries: SessionEntry[]): void;
  /** Registers local knowledge of a session; known title/updatedAt survive. */
  upsertSession(entry: SessionUpsert): void;
  /** Applies a live session_info_update; undefined fields are untouched. */
  patchSession(sessionId: string, patch: { title?: string | null; updatedAt?: string | null }): void;
  removeSession(sessionId: string): void;
  // -- transactional session switch (issue #17) --------------------------------
  /**
   * Stages the switch target: routes this port's writes to the target and
   * guarantees its document exists, but does NOT move the UI pointer or
   * `connection.sessionId` — those are settled-state, owned by
   * `commitStagedSession`. Returns the pre-state snapshot for rollback.
   */
  stageSession(sessionId: string, cwd: string): SessionSwitchSnapshot;
  /**
   * Commits the staged switch: moves `connection.sessionId` and (for the
   * active connection) `activeSessionId` to the staged session.
   */
  commitStagedSession(): void;
  /**
   * Rolls the switch back: restores the target's pre-switch document (or
   * removes the placeholder it never had) — pending permissions ride on
   * the document (issue #18) — plus `connection.sessionId` and this port's
   * routing. The UI pointer never moved, so it needs no restore.
   */
  rollbackStagedSession(snapshot: SessionSwitchSnapshot): void;
};

export function connectionStorePort(connectionId: string): ConnectionStorePort {
  /** The session this port's driver currently feeds; set via adoptSession. */
  let currentSessionId: string | null = null;

  /** Patches this port's slot under the store's immutability + guard rules. */
  const patchSlot = (patch: (state: ConnectionState) => Partial<ConnectionState>) =>
    usePanda.setState((s) => patchConnectionState(s, connectionId, patch) ?? {});

  /** Patches the adopted session's document inside this port's slot. */
  const patchDoc = (fn: (doc: SessionDocument) => SessionDocument) => {
    if (currentSessionId === null) {
      // Defensive double guard — public actions already checked via
      // requireSession; if this ever fires the call chain drifted.
      console.warn(`[store] connection "${connectionId}" doc write before adopting a session — dropped`);
      return;
    }
    const sessionId = currentSessionId;
    patchSlot((state) => ({
      docs: { ...state.docs, [sessionId]: fn(state.docs[sessionId] ?? EMPTY_DOC) },
    }));
  };

  const requireSession = (action: string): boolean => {
    if (currentSessionId !== null) return true;
    console.warn(`[store] connection "${connectionId}" ${action} before adopting a session — dropped`);
    return false;
  };

  return {
    adoptSession: (sessionId, cwd) => {
      currentSessionId = sessionId;
      usePanda.setState((s) => {
        const patched = patchConnectionState(s, connectionId, (state) => {
          const known = state.sessions.find((entry) => entry.sessionId === sessionId);
          return {
            docs: { ...state.docs, [sessionId]: state.docs[sessionId] ?? emptySession() },
            connection: { ...state.connection, sessionId },
            sessions: upsertEntries(state.sessions, [
              {
                sessionId,
                cwd,
                title: known?.title ?? null,
                updatedAt: known?.updatedAt ?? null,
              },
            ]),
          };
        });
        return {
          ...(patched ?? {}),
          // Only the active connection moves the UI pointer.
          ...(s.activeConnectionId === connectionId || s.activeConnectionId === null
            ? { activeSessionId: sessionId }
            : {}),
        };
      });
    },
    update: (update) => {
      if (!requireSession('update')) return;
      patchDoc((doc) => applyUpdate(doc, update));
    },
    setStatus: (status) => {
      if (!requireSession('status')) return;
      patchDoc((doc) => ({ ...doc, status }));
    },
    setConnection: (patch) =>
      patchSlot((state) => ({ connection: { ...state.connection, ...patch } })),
    resetDocument: () => {
      // Resetting with no adopted session is a no-op, not a warning: drivers
      // legitimately reset on a fresh connect before any session exists.
      if (currentSessionId === null) return;
      const sessionId = currentSessionId;
      patchSlot((state) => ({
        docs: { ...state.docs, [sessionId]: emptySession() },
      }));
    },
    setCapabilities: (caps) => patchSlot(() => ({ capabilities: caps })),
    mergeSessions: (entries) =>
      patchSlot((state) => ({ sessions: upsertEntries(state.sessions, entries) })),
    replaceSessions: (entries) =>
      patchSlot(() => ({ sessions: upsertEntries([], entries) })),
    upsertSession: (entry) =>
      patchSlot((state) => {
        const existing = state.sessions.find((e) => e.sessionId === entry.sessionId);
        const merged: SessionEntry = {
          sessionId: entry.sessionId,
          cwd: entry.cwd,
          title: entry.title ?? existing?.title ?? null,
          updatedAt: entry.updatedAt ?? existing?.updatedAt ?? null,
        };
        return { sessions: upsertEntries(state.sessions, [merged]) };
      }),
    patchSession: (sessionId, patch) =>
      patchSlot((state) => ({
        sessions: state.sessions.map((entry) =>
          entry.sessionId === sessionId ? { ...entry, ...patch } : entry,
        ),
      })),
    removeSession: (sessionId) => {
      currentSessionId = currentSessionId === sessionId ? null : currentSessionId;
      usePanda.setState((s) => {
        const patched = patchConnectionState(s, connectionId, (state) => ({
          sessions: state.sessions.filter((entry) => entry.sessionId !== sessionId),
          docs: Object.fromEntries(Object.entries(state.docs).filter(([id]) => id !== sessionId)),
        }));
        // The deleted session must not stay behind as a dangling UI pointer.
        return {
          ...(patched ?? {}),
          ...(s.activeSessionId === sessionId ? { activeSessionId: null } : {}),
        };
      });
    },
    stageSession: (sessionId, cwd) => {
      const slot = usePanda.getState().connections[connectionId];
      const snapshot: SessionSwitchSnapshot = {
        targetSessionId: sessionId,
        prevSessionId: currentSessionId,
        targetDoc: slot?.docs[sessionId] ?? null,
        connectionSessionId: slot?.connection.sessionId ?? null,
      };
      currentSessionId = sessionId;
      usePanda.setState((s) => {
        const patched = patchConnectionState(s, connectionId, (state) => {
          const known = state.sessions.find((entry) => entry.sessionId === sessionId);
          return {
            docs: { ...state.docs, [sessionId]: state.docs[sessionId] ?? emptySession() },
            switching: { sessionId },
            // A new transaction starts from a clean slate — a previous
            // switch's failure banner must not linger into it.
            connection: { ...state.connection, error: null },
            sessions: upsertEntries(state.sessions, [
              {
                sessionId,
                cwd,
                title: known?.title ?? null,
                updatedAt: known?.updatedAt ?? null,
              },
            ]),
          };
        });
        return patched ?? {};
      });
      return snapshot;
    },
    commitStagedSession: () => {
      const sessionId = currentSessionId;
      if (sessionId === null) {
        // Never leave `switching` set on this path: a stale marker would lock
        // the UI busy forever (nothing else can clear it once staged).
        console.warn(`[store] connection "${connectionId}" commitStagedSession without a staged session — ignored`);
        usePanda.setState((s) => patchConnectionState(s, connectionId, () => ({ switching: null })) ?? {});
        return;
      }
      usePanda.setState((s) => {
        const patched = patchConnectionState(s, connectionId, (state) => ({
          connection: { ...state.connection, sessionId },
          switching: null,
        }));
        return {
          ...(patched ?? {}),
          // Only the active connection moves the UI pointer (same rule as
          // adoptSession) — and only now: a failed switch must leave the
          // user where they were.
          ...(s.activeConnectionId === connectionId || s.activeConnectionId === null
            ? { activeSessionId: sessionId }
            : {}),
        };
      });
    },
    rollbackStagedSession: (snapshot) => {
      currentSessionId = snapshot.prevSessionId;
      usePanda.setState((s) => {
        const patched = patchConnectionState(s, connectionId, (state) => {
          const docs = { ...state.docs };
          const stillListed = state.sessions.some((entry) => entry.sessionId === snapshot.targetSessionId);
          if (stillListed) {
            if (snapshot.targetDoc) docs[snapshot.targetSessionId] = snapshot.targetDoc;
            else delete docs[snapshot.targetSessionId];
          } else if (snapshot.targetDoc) {
            // The target was deleted mid-switch (delete wins over the stale
            // transaction) — restoring its document would resurrect it.
            console.warn(
              `[store] connection "${connectionId}" rollback for deleted session ${snapshot.targetSessionId} — document not restored`,
            );
          }
          // The sidebar entry is deliberately NOT rolled back: stage's
          // metadata upsert (cwd/title/updatedAt retention) is a keeper.
          return {
            docs,
            connection: { ...state.connection, sessionId: snapshot.connectionSessionId },
            switching: null,
          };
        });
        return patched ?? {};
      });
    },
  };
}

/** Shared fallback — the reducer is immutable, so a single instance is safe. */
export const EMPTY_DOC: SessionDocument = emptySession();

// ---------------------------------------------------------------------------
// UI selectors (single-connection mode: the active connection is the only one)
// ---------------------------------------------------------------------------

const EMPTY_CONNECTION_STATE = emptyConnectionState();

function activeConnectionState(s: PandaState): ConnectionState {
  return (
    (s.activeConnectionId ? s.connections[s.activeConnectionId] : undefined) ??
    EMPTY_CONNECTION_STATE
  );
}

/** The document the UI renders; a stable empty fallback keeps selectors cheap. */
export const useActiveDoc = () =>
  usePanda((s) => {
    const connection = activeConnectionState(s);
    return (s.activeSessionId ? connection.docs[s.activeSessionId] : undefined) ?? EMPTY_DOC;
  });

export const useActiveConnection = () => usePanda((s) => activeConnectionState(s).connection);

export const useActiveSessions = () => usePanda((s) => activeConnectionState(s).sessions);

export const useActiveCapabilities = () => usePanda((s) => activeConnectionState(s).capabilities);

/** The in-flight transactional switch on the active connection, or null. */
export const useActiveSwitching = () => usePanda((s) => activeConnectionState(s).switching);
