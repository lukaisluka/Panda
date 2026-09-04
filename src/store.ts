import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { applyUpdate, emptySession } from './protocol/reducer';
import type {
  AcpSessionUpdate,
  SessionDocument,
  SessionStatus,
} from './protocol/types';
import {
  PANDA_HOST_CAPABILITIES,
  effectiveCapabilities,
  type AgentCapabilityDeclarations,
} from './capabilities';

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

/**
 * What the current agent advertised at initialize (v1 capability gates).
 * An alias of the composition module's declarations type (issue #22): one
 * canonical shape, so the five keys cannot drift between store and
 * decision point.
 */
export type AgentCapabilityInfo = AgentCapabilityDeclarations;

export type SessionMode = 'demo' | 'live';

/**
 * The demo replay's pseudo-connection slot (issue #21): defined here so the
 * sidebar's ordering selector can exclude it without importing the driver —
 * the replay slot is not an agent connection and never renders as a group.
 */
export const DEMO_CONNECTION_ID = 'demo';

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
   * `activeSessionId`, which only a commit may move. `selectionToken` is the
   * store's selection generation minted at stage (issue #19): a settle may
   * only clear the marker its own transaction set — two switches to the same
   * session (a retry) would be indistinguishable by sessionId alone.
   */
  switching: { sessionId: string; selectionToken: number } | null;
  /**
   * Unread signal (issue #21): a running turn settled while this connection
   * was in the background. Cleared when the connection becomes the foreground
   * one — "看过" means it was foregrounded, not that the transcript was read.
   * One of the three sources of the aggregated 需要关注 indicator; the other
   * two (pending permissions, connection error) are derived from the document
   * and `connection.status` so the document stays their single source.
   */
  unreadCompletion: boolean;
  /**
   * Last turn activity (issue #21): bumped on status transitions and session
   * adoption. Drives sidebar ordering — the foreground connection is pinned,
   * the rest sort by recency, so the timestamp never needs to be exact.
   */
  lastActivityAt: number | null;
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
  /**
   * Selection token minted at stage (issue #19): the store's
   * `selectionGeneration` when this transaction became the latest
   * selection. A commit/rollback whose token no longer matches has been
   * superseded — it may restore era-scoped documents but must not move
   * settled pointers (latest-wins).
   */
  selectionToken: number;
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
  /**
   * Selection generation (issue #19): minted (incremented) every time a new
   * selection attempt becomes the latest — a staged switch, a delete that
   * invalidates selections pointing at it, or a close. A pointer-moving
   * commit carrying an older token has been superseded and is ignored
   * (latest-wins).
   */
  selectionGeneration: number;
  setMode(mode: SessionMode): void;
  /**
   * Creates the slot if missing (existing documents survive — reconnects keep
   * their transcript) and makes it the active connection.
   */
  ensureConnection(connectionId: string): void;
  /** Drops a slot entirely; clears the pointers if it was active. */
  closeConnection(connectionId: string): void;
  /**
   * Foregrounds a connection (issue #21): points the UI at the connection
   * and — unless a session is given explicitly — at its settled session, and
   * clears the unread signal (foregrounding is "看过"). Unlike
   * `ensureConnection` this is a UI action, not driver plumbing, so it moves
   * both pointers at once and fails loudly on an unknown id.
   */
  setActiveConnection(connectionId: string, sessionId?: string): void;
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
    unreadCompletion: false,
    lastActivityAt: null,
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
  selectionGeneration: 0,
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
  setActiveConnection: (connectionId, sessionId) =>
    set((s) => {
      const existing = s.connections[connectionId];
      if (!existing) {
        console.warn(`[store] setActiveConnection for unknown connection "${connectionId}" — ignored`);
        return {};
      }
      // The foreground connection's settled session becomes the UI session;
      // an explicit sessionId only makes sense for retained-document viewing
      // (a disconnected slot's history) — live switches move the pointer via
      // their own transactional commit, never through this action.
      return {
        activeConnectionId: connectionId,
        activeSessionId: sessionId ?? existing.connection.sessionId ?? null,
        connections: {
          ...s.connections,
          [connectionId]: { ...existing, unreadCompletion: false },
        },
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
  /**
   * Invalidates every in-flight selection (issue #19: close/disconnect) —
   * commits carrying older tokens stop moving the UI pointer.
   */
  invalidateSelections(): void;
  // -- transactional session switch (issue #17) --------------------------------
  /**
   * Stages the switch target: routes this port's writes to the target and
   * guarantees its document exists, but does NOT move the UI pointer or
   * `connection.sessionId` — those are settled-state, owned by
   * `commitStagedSession`. Staging also mints the store's selection
   * generation, making this transaction the latest selection (issue #19):
   * any older in-flight commit/rollback becomes superseded. Returns the
   * pre-state snapshot for rollback.
   */
  stageSession(sessionId: string, cwd: string): SessionSwitchSnapshot;
  /**
   * Commits the staged switch: moves `connection.sessionId` and (for the
   * active connection) `activeSessionId` to the staged session — unless the
   * snapshot's selection token was superseded (issue #19): a newer selection
   * owns the settled pointers by then, so a stale commit clears at most its
   * own `switching` marker.
   */
  commitStagedSession(snapshot: SessionSwitchSnapshot | null): void;
  /**
   * Rolls the switch back: restores the target's pre-switch document (or
   * removes the placeholder it never had) — pending permissions ride on
   * the document (issue #18) — plus `connection.sessionId` and this port's
   * routing. A superseded rollback restores documents only; the settled
   * routing belongs to the newer selection (issue #19). The UI pointer never
   * moved, so it needs no restore.
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
            lastActivityAt: Date.now(),
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
      // Same narrowing shape as patchDoc: the null check must live in this
      // function body for TS to carry it into the setState closure below.
      if (currentSessionId === null) {
        console.warn(`[store] connection "${connectionId}" status before adopting a session — dropped`);
        return;
      }
      const sessionId = currentSessionId;
      usePanda.setState((s) => {
        const patched = patchConnectionState(s, connectionId, (state) => {
          const prevStatus = state.docs[sessionId]?.status ?? 'idle';
          // Unread signal (issue #21): a running turn settled while this
          // connection was backgrounded (which includes "no foreground at
          // all"). A turn KILLED by a disconnect also lands idle here — the
          // connection's error status signals attention anyway, and the extra
          // unread flag clears on the same foregrounding.
          const completedInBackground =
            s.activeConnectionId !== connectionId && prevStatus === 'running' && status === 'idle';
          return {
            docs: { ...state.docs, [sessionId]: { ...(state.docs[sessionId] ?? EMPTY_DOC), status } },
            lastActivityAt: Date.now(),
            ...(completedInBackground ? { unreadCompletion: true } : {}),
          };
        });
        return patched ?? {};
      });
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
      const slot = usePanda.getState().connections[connectionId];
      // A delete only invalidates selections pointing at the deleted session
      // (issue #19) — an unrelated in-flight switch must survive it. "Points
      // at" covers the routed, the staged AND the settled pointer: a late
      // commit onto a world where the predecessor was deleted must not move
      // pointers built on it.
      const touchesSelection =
        currentSessionId === sessionId ||
        slot?.switching?.sessionId === sessionId ||
        slot?.connection.sessionId === sessionId;
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
          ...(touchesSelection ? { selectionGeneration: s.selectionGeneration + 1 } : {}),
        };
      });
    },
    invalidateSelections: () => {
      // Observable by design (issue #19): this fires on close/disconnect and
      // connect replacement — the trace line makes a dangling commit's
      // "superseded" warning diagnosable after the fact.
      console.info(`[store] connection "${connectionId}" selection generation invalidated — in-flight commits stop moving pointers`);
      usePanda.setState((s) => ({ selectionGeneration: s.selectionGeneration + 1 }));
    },
    stageSession: (sessionId, cwd) => {
      // Mint the selection token, snapshot the pre-state and stage the slot
      // in ONE atomic update (issue #19): split setStates would let a racing
      // stage read a token another stage had already superseded, and reading
      // the slot after staging would capture the placeholder as `targetDoc`.
      let selectionToken = 0;
      let snapshot: SessionSwitchSnapshot | null = null;
      usePanda.setState((s) => {
        selectionToken = s.selectionGeneration + 1;
        const existing = s.connections[connectionId];
        snapshot = {
          targetSessionId: sessionId,
          prevSessionId: currentSessionId,
          targetDoc: existing?.docs[sessionId] ?? null,
          connectionSessionId: existing?.connection.sessionId ?? null,
          selectionToken,
        };
        const patched = patchConnectionState(s, connectionId, (state) => {
          const known = state.sessions.find((entry) => entry.sessionId === sessionId);
          return {
            docs: { ...state.docs, [sessionId]: state.docs[sessionId] ?? emptySession() },
            switching: { sessionId, selectionToken },
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
        return { ...(patched ?? {}), selectionGeneration: selectionToken };
      });
      currentSessionId = sessionId;
      // The updater ran synchronously; the non-null holds unless setState
      // itself failed — fail loud rather than stage with a torn snapshot.
      if (!snapshot) throw new Error(`[store] connection "${connectionId}" stageSession snapshot missing after staging`);
      return snapshot;
    },
    commitStagedSession: (snapshot) => {
      if (snapshot === null) {
        // Never leave `switching` set on this path: a stale marker would lock
        // the UI busy forever (nothing else can clear it once staged).
        console.warn(`[store] connection "${connectionId}" commitStagedSession without a staged snapshot — ignored`);
        usePanda.setState((s) => patchConnectionState(s, connectionId, () => ({ switching: null })) ?? {});
        return;
      }
      const stale = usePanda.getState().selectionGeneration !== snapshot.selectionToken;
      if (stale) {
        // Latest-wins (issue #19): a newer selection (or an invalidating
        // delete/close) owns the settled pointers — this late commit moves
        // nothing. Its replay history lives on in the target's document.
        console.warn(
          `[store] connection "${connectionId}" switch to ${snapshot.targetSessionId} superseded ` +
            `(selection token ${snapshot.selectionToken}) — settled pointers untouched`,
        );
        usePanda.setState((s) =>
          patchConnectionState(s, connectionId, (state) => ({
            // Clear only this transaction's marker: a newer stage may have
            // set its own (token match — the same sessionId can stage twice,
            // e.g. a retry).
            switching: state.switching?.selectionToken === snapshot.selectionToken
              ? null
              : state.switching,
          })) ?? {},
        );
        return;
      }
      const sessionId = snapshot.targetSessionId;
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
      const stale = usePanda.getState().selectionGeneration !== snapshot.selectionToken;
      if (!stale) currentSessionId = snapshot.prevSessionId;
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
            // A superseded rollback restores documents only (issue #19): the
            // settled routing belongs to the newer selection by now.
            connection: stale
              ? state.connection
              : { ...state.connection, sessionId: snapshot.connectionSessionId },
            // Token-matched clear (P3-9): the same sessionId can stage twice
            // (a retry) — only this transaction's own marker may go.
            switching: state.switching?.selectionToken === snapshot.selectionToken
              ? null
              : state.switching,
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
// UI selectors (the active connection is the foreground one; #21 keeps the
// useActive* family bound to it while the sidebar reads every slot)
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

/**
 * Effective capabilities of the foreground connection (issue #22): the
 * single decision point, composed per foreground slot. Verdicts are
 * interned, so useShallow keeps this hook from re-rendering on unrelated
 * store churn — it only fires when a verdict actually flips.
 */
export const useActiveEffectiveCapabilities = () =>
  usePanda(useShallow((s) => effectiveCapabilities(activeConnectionState(s).capabilities, PANDA_HOST_CAPABILITIES)));

/** The in-flight transactional switch on the active connection, or null. */
export const useActiveSwitching = () => usePanda((s) => activeConnectionState(s).switching);

// -- sidebar grouping + indicators (issue #21) -------------------------------

/**
 * Sidebar group order (issue #21): the foreground connection first, the rest
 * by most recent turn activity, never-active slots last; the demo replay
 * pseudo-slot is not a group. Stable by id so ties don't reshuffle.
 */
export function orderedConnectionIds(s: {
  connections: Record<string, ConnectionState>;
  activeConnectionId: string | null;
}): string[] {
  return Object.keys(s.connections)
    .filter((id) => id !== DEMO_CONNECTION_ID)
    .sort((a, b) => {
      if (a === s.activeConnectionId) return -1;
      if (b === s.activeConnectionId) return 1;
      const at = s.connections[a]?.lastActivityAt ?? null;
      const bt = s.connections[b]?.lastActivityAt ?? null;
      if (at !== null && bt === null) return -1;
      if (at === null && bt !== null) return 1;
      if (at !== null && bt !== null && at !== bt) return bt - at;
      return a.localeCompare(b);
    });
}

/**
 * The ordered group ids as a hook. useShallow keeps the string array's
 * identity stable while the underlying slots churn (every streamed chunk
 * replaces a ConnectionState) — the sidebar only re-renders when the group
 * membership or order actually changes.
 */
export const useConnectionOrder = () => usePanda(useShallow(orderedConnectionIds));

/** True while any of the connection's documents is mid-turn (每连接单 pending turn). */
export function isConnectionRunning(slot: ConnectionState): boolean {
  return Object.values(slot.docs).some((doc) => doc.status === 'running');
}

/** 连接级 busy: a transactional session switch or a running turn — the
 * states in which session switching/creating is refused. */
export function isConnectionBusy(slot: ConnectionState): boolean {
  return slot.switching !== null || isConnectionRunning(slot);
}

/** True while any of the connection's documents has a pending permission. */
export function hasPendingPermission(slot: ConnectionState): boolean {
  return Object.values(slot.docs).some((doc) =>
    Object.values(doc.permissions).some((permission) => permission.status === 'pending'),
  );
}

/**
 * Aggregated 需要关注 (issue #21): unread completion | pending permission |
 * connection error — any source lights the dot. Derived, not stored: the
 * document and `connection.status` stay the single sources of truth.
 */
export function needsAttention(slot: ConnectionState): boolean {
  return slot.unreadCompletion || slot.connection.status === 'error' || hasPendingPermission(slot);
}
