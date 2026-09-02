import { create } from 'zustand';
import { applyUpdate, emptySession } from './protocol/reducer';
import type {
  AcpSessionUpdate,
  PermissionRequest,
  SessionDocument,
  SessionStatus,
} from './protocol/types';

/**
 * Thin store around the reducer — all mutation flows through `applyUpdate`,
 * the store never invents document state itself. Connection/session bookkeeping
 * lives beside the document but is set only by the session drivers (replay or
 * live client), never derived here.
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

interface PandaState {
  doc: SessionDocument;
  permission: PermissionRequest | null;
  connection: ConnectionInfo;
  mode: SessionMode;
  sessions: SessionEntry[];
  capabilities: AgentCapabilityInfo;
  update(update: AcpSessionUpdate): void;
  setStatus(status: SessionStatus): void;
  setPermission(request: PermissionRequest | null): void;
  setConnection(patch: Partial<ConnectionInfo>): void;
  setMode(mode: SessionMode): void;
  /** Clears turns/usage/permission — used when starting a session or replay. */
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
}

/** A session as locally known — sparse fields merge with existing knowledge. */
export type SessionUpsert = {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
};

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

function upsertEntries(existing: SessionEntry[], incoming: SessionEntry[]): SessionEntry[] {
  const byId = new Map(existing.map((entry) => [entry.sessionId, entry]));
  for (const entry of incoming) byId.set(entry.sessionId, entry);
  return [...byId.values()];
}

export const usePanda = create<PandaState>((set) => ({
  doc: emptySession(),
  permission: null,
  connection: initialConnection,
  mode: 'demo',
  sessions: [],
  capabilities: initialCapabilities,
  update: (update) => set((s) => ({ doc: applyUpdate(s.doc, update) })),
  setStatus: (status) => set((s) => ({ doc: { ...s.doc, status } })),
  setPermission: (request) => set({ permission: request }),
  setConnection: (patch) => set((s) => ({ connection: { ...s.connection, ...patch } })),
  setMode: (mode) => set({ mode }),
  resetDocument: () => set({ doc: emptySession(), permission: null }),
  setCapabilities: (caps) => set({ capabilities: caps }),
  mergeSessions: (entries) => set((s) => ({ sessions: upsertEntries(s.sessions, entries) })),
  replaceSessions: (entries) => set({ sessions: upsertEntries([], entries) }),
  upsertSession: (entry) =>
    set((s) => {
      const existing = s.sessions.find((e) => e.sessionId === entry.sessionId);
      const merged: SessionEntry = {
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        title: entry.title ?? existing?.title ?? null,
        updatedAt: entry.updatedAt ?? existing?.updatedAt ?? null,
      };
      return { sessions: upsertEntries(s.sessions, [merged]) };
    }),
  patchSession: (sessionId, patch) =>
    set((s) => ({
      sessions: s.sessions.map((entry) =>
        entry.sessionId === sessionId ? { ...entry, ...patch } : entry,
      ),
    })),
  removeSession: (sessionId) =>
    set((s) => ({ sessions: s.sessions.filter((entry) => entry.sessionId !== sessionId) })),
}));
