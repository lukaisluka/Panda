import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { LiveAcpClient } from './acp/LiveAcpClient';
import { WebSocketTransport } from './acp/transport/WebSocketTransport';
import type {
  AcpContentBlock,
  AcpSessionModeState,
  AcpSessionUpdate,
  ElicitationResponse,
  PermissionOptionKind,
  SessionStatus,
} from './protocol/types';
import { connectionStorePort, usePanda, type ConnectionStorePort, type SessionEntry, type SessionSwitchSnapshot } from './store';
import { updateProfileFields, type AgentProfile } from './profiles';
import { cwdToWorkspace, workspaceToCwd, type Workspace } from './workspace';
import { alwaysAskPolicy, type PermissionDecision, type PermissionPolicy } from './policy';

/**
 * Live connection manager (issue #21, ADR 0002): one `LiveAcpClient` + one
 * connection-scoped store port per active connection. The map's key IS the
 * connection's identity — an Agent 配置 id for profile connections, a
 * `direct:`-prefixed random id for 临时直连. Everything the single-slot
 * driver used to hardcode ("the live connection") resolves through the map
 * and the store's `activeConnectionId` at call time.
 *
 * Lifecycle (CONTEXT.md 断开/移除): disconnecting a PROFILE connection keeps
 * its slot — history stays visible, resume stays offered; a DIRECT
 * connection is removed with its disconnect (断开即结束). Explicit removal
 * drops the slot and every local document (orphan cleanup, acp-components
 * `removeAgent` semantics).
 */

const URL_KEY = 'panda.acp.url';
const CWD_KEY = 'panda.acp.cwd';
const SESSIONS_KEY_PREFIX = 'panda.sessions:';
const PERSIST_LIMIT = 50;

/** 临时直连 ids carry this prefix; everything else is a profile id. */
export const DIRECT_CONNECTION_PREFIX = 'direct:';

export function isDirectConnectionId(connectionId: string): boolean {
  return connectionId.startsWith(DIRECT_CONNECTION_PREFIX);
}

export function newDirectConnectionId(): string {
  return DIRECT_CONNECTION_PREFIX + globalThis.crypto.randomUUID();
}

/** Remembers the endpoint between reloads; persistence is best-effort. */
function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    console.warn(`[panda] could not persist ${key}`, err);
  }
}

/** Last-used endpoint values for prefilling the connect form. The remembered
 * cwd reads back through `cwdToWorkspace` — `/` (the 无工作区 placeholder,
 * ADR 0005) becomes `{kind: 'none'}`, anything else a local directory. */
export function lastConnectionDefaults(): { url: string; workspace: Workspace } {
  return {
    url: localStorage.getItem(URL_KEY) ?? '',
    workspace: cwdToWorkspace(localStorage.getItem(CWD_KEY) ?? ''),
  };
}

export interface SessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function loadPersistedSessions(url: string, storage: SessionStorage = globalThis.localStorage): SessionEntry[] {
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
 * replacement, never a merge: a connection's visible list belongs to one
 * endpoint at a time, so entries from a previously selected endpoint must
 * not bleed into it.
 */
export function restoreEndpointSessions(
  url: string,
  replaceSessions: (entries: SessionEntry[]) => void,
  storage: SessionStorage = globalThis.localStorage,
): void {
  replaceSessions(loadPersistedSessions(url, storage));
}

/**
 * Persists the union of every connection's session list per endpoint
 * (issue #21): two parallel connections to the same URL each know part of
 * the truth (their own merges/upserts), and the persisted list is the
 * endpoint's memory — not one connection's view of it. The union also
 * includes what is already persisted: sessions of a removed connection (or
 * an ended 临时直连) stay remembered because the agent server still has
 * them — only an explicit session/delete (which purges the entry) or the
 * per-endpoint cap removes one. Entries merge by sessionId with later
 * timestamps winning; the newest PERSIST_LIMIT survive.
 */
export function persistSessionsSnapshot(
  connections: Array<{ url: string | null; sessions: SessionEntry[] }>,
  storage: SessionStorage = globalThis.localStorage,
): void {
  const byUrl = new Map<string, Map<string, SessionEntry>>();
  const fold = (url: string, entry: SessionEntry) => {
    let entries = byUrl.get(url);
    if (!entries) {
      entries = new Map();
      byUrl.set(url, entries);
    }
    const known = entries.get(entry.sessionId);
    entries.set(entry.sessionId, {
      ...entry,
      title: entry.title ?? known?.title ?? null,
      updatedAt: entry.updatedAt ?? known?.updatedAt ?? null,
    });
  };
  for (const slot of connections) {
    const url = slot.url;
    if (!url) continue;
    for (const entry of slot.sessions) fold(url, entry);
  }
  for (const [url, entries] of byUrl) {
    for (const entry of loadPersistedSessions(url, storage)) fold(url, entry);
    const ordered = [...entries.values()].sort((a, b) =>
      (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
    );
    try {
      storage.setItem(SESSIONS_KEY_PREFIX + url, JSON.stringify(ordered.slice(0, PERSIST_LIMIT)));
    } catch (err) {
      console.warn(`[panda] could not persist sessions for ${url}`, err);
    }
  }
}

/** Drops one session from an endpoint's persisted memory (session/delete). */
function purgePersistedSession(url: string, sessionId: string, storage: SessionStorage = globalThis.localStorage): void {
  const kept = loadPersistedSessions(url, storage).filter((entry) => entry.sessionId !== sessionId);
  try {
    storage.setItem(SESSIONS_KEY_PREFIX + url, JSON.stringify(kept));
  } catch (err) {
    console.warn(`[panda] could not persist sessions for ${url}`, err);
  }
}

// ---------------------------------------------------------------------------
// Per-connection entries
// ---------------------------------------------------------------------------

/** Client seam for tests: receives the wired handlers, returns the client. */
export type LiveClientFactory = (handlers: import('./acp/LiveAcpClient').LiveClientHandlers) => LiveAcpClient;

type LiveConnection = {
  connectionId: string;
  client: LiveAcpClient;
  port: ConnectionStorePort;
  /**
   * Snapshot of the in-flight session switch (issue #17) — captured at stage,
   * consumed by exactly one commit or rollback, era-guarded (issue #19).
   */
  stagedSwitch: { snapshot: SessionSwitchSnapshot; era: number } | null;
  /** Profile targeted by the in-flight connect — consumed on success (write-back). */
  pendingProfile: { id: string; url: string; workspace: Workspace } | null;
};

const liveConnections = new Map<string, LiveConnection>();

/**
 * The active permission policy (issue #22): every `session/request_permission`
 * on every connection consults it before hanging for the user. The default
 * hands every decision to the user (ADR 0004 — auto-approval is not
 * expressible); tests (and a future settings surface) swap this seam.
 */
let activePermissionPolicy: PermissionPolicy = alwaysAskPolicy;

/** Test seam: override the active permission policy; null restores the default. */
export function __setPermissionPolicy(policy: PermissionPolicy | null): void {
  activePermissionPolicy = policy ?? alwaysAskPolicy;
}

/**
 * Binds the policy's connection context (issue #22): the policy sees WHICH
 * connection and endpoint a permission belongs to, read at request time —
 * it is only known once connect() has stored it. The trace log here is the
 * judgment's observability line: connection, request, verdict (the client's
 * own log only knows the mechanics, not the connection).
 */
function bindPolicyToConnection(
  connectionId: string,
): (request: RequestPermissionRequest) => PermissionDecision {
  return (request) => {
    const slot = usePanda.getState().connections[connectionId];
    const url = slot?.connection.url ?? null;
    if (!url) {
      // Permissions only arrive while a session lives, so the slot and its
      // url must exist by then; missing means bookkeeping drifted — loud,
      // or a policy misjudgment becomes undiagnosable.
      console.warn(
        `[panda/acp:${connectionId}] policy consult without a stored endpoint url — context degraded to null`,
      );
    }
    const verdict = activePermissionPolicy(request, { connectionId, url });
    console.info(
      `[panda/acp:${connectionId}] permission ${request.toolCall.toolCallId} policy verdict: ${verdict}`,
    );
    return verdict;
  };
}

/** Test seams: per-id overrides and a fallback for ids created after setup. */
const clientFactories = new Map<string, LiveClientFactory>();
let defaultClientFactory: LiveClientFactory | null = null;

function ensureEntry(connectionId: string): LiveConnection {
  const existing = liveConnections.get(connectionId);
  if (existing) return existing;
  const entry: LiveConnection = {
    connectionId,
    client: null as unknown as LiveAcpClient,
    port: connectionStorePort(connectionId),
    stagedSwitch: null,
    pendingProfile: null,
  };
  const factory =
    clientFactories.get(connectionId) ??
    defaultClientFactory ??
    ((handlers) => new LiveAcpClient(handlers, { policy: bindPolicyToConnection(connectionId) }));
  entry.client = factory(wireHandlers(entry));
  liveConnections.set(connectionId, entry);
  return entry;
}

function wireHandlers(entry: LiveConnection) {
  const { connectionId, port } = entry;
  return {
    onUpdate: (update: AcpSessionUpdate) => port.update(update),
    onStatus: (status: SessionStatus) => port.setStatus(status),
    onConnected: (info: { agentName: string; protocolVersion: number }) => {
      port.setConnection({
        status: 'connected',
        agentName: info.agentName,
        protocolVersion: info.protocolVersion,
        error: null,
      });
      // "默认工作区" = what the last successful connect used (issue #2, #23).
      const pending = entry.pendingProfile;
      if (pending) updateProfileFields(pending.id, { url: pending.url, workspace: pending.workspace });
      entry.pendingProfile = null;
    },
    onSessionId: (sessionId: string, cwd: string) => port.adoptSession(sessionId, cwd),
    onSessionModes: (modes: AcpSessionModeState | null) =>
      port.update({ sessionUpdate: 'modes_initialized', modes }),
    // An unexpected disconnect keeps the session id so the group can offer
    // "reconnect and resume"; a clean user disconnect clears it. Either way
    // a failed connect must not write its edits back into the profile.
    onDisconnected: (reason: string | null) => {
      entry.pendingProfile = null;
      // A closed connection can no longer settle a selection (issue #19):
      // any in-flight switch's late commit stops moving the UI pointer, and
      // its staged snapshot is rolled back stale (documents only).
      abandonStagedSwitch(entry, 'disconnect');
      port.setConnection(
        reason
          ? { status: 'error', error: reason }
          : { status: 'disconnected', error: null, sessionId: null },
      );
    },
    onCapabilities: (caps: {
      image: boolean;
      loadSession: boolean;
      list: boolean;
      resume: boolean;
      delete: boolean;
    }) =>
      port.setCapabilities({
        image: caps.image,
        loadSession: caps.loadSession,
        list: caps.list,
        resume: caps.resume,
        delete: caps.delete,
      }),
    onSessions: (entries: SessionEntry[]) => port.mergeSessions(entries),
    onSessionInfo: (sessionId: string, info: { title?: string | null; updatedAt?: string | null }) =>
      port.patchSession(sessionId, info),
    onReplayStart: () => port.resetDocument(),
    onSessionDeleted: (sessionId: string) => port.removeSession(sessionId),
    onSessionSwitchStage: (sessionId: string, cwd: string, era: number) => {
      entry.stagedSwitch = { snapshot: port.stageSession(sessionId, cwd), era };
    },
    onSessionSwitchCommit: (era: number) => {
      const staged = entry.stagedSwitch;
      if (!staged || staged.era !== era) {
        // The switch was abandoned (reconnect/disconnect rolled it back
        // stale) or belongs to another era — a late commit must not consume
        // a snapshot the current era never staged (issue #19).
        console.info(`[panda/acp:${connectionId}] session switch commit from era ${era} ignored (staged: ${staged ? `era ${staged.era}` : 'none'})`);
        return;
      }
      entry.stagedSwitch = null;
      // The snapshot carries the selection token (issue #19): a commit for
      // a superseded switch moves no settled pointer.
      port.commitStagedSession(staged.snapshot);
    },
    onSessionSwitchRollback: (reason: string, era: number) => {
      const staged = entry.stagedSwitch;
      if (!staged || staged.era !== era) {
        // Expected after abandonment — info, not error: the store's token
        // check is the second line of defense and warns there if it matters.
        console.info(`[panda/acp:${connectionId}] session switch rollback from era ${era} ignored (staged: ${staged ? `era ${staged.era}` : 'none'})`);
        return;
      }
      entry.stagedSwitch = null;
      port.rollbackStagedSession(staged.snapshot);
      // Surface the failure on a live connection only: after a disconnect
      // a stale error banner must not linger.
      if (usePanda.getState().connections[connectionId]?.connection.status === 'connected') {
        port.setConnection({ error: `切换会话失败: ${reason}` });
      }
    },
  };
}

/**
 * Abandons the entry's staged switch (issue #19): the connection era it
 * belongs to is gone (a new connect is replacing it, or the connection
 * died). The invalidation mints a fresh selection generation FIRST, so the
 * rollback below lands stale — documents restored, settled pointers
 * untouched.
 */
function abandonStagedSwitch(entry: LiveConnection, where: string): void {
  const staged = entry.stagedSwitch;
  if (!staged) return;
  entry.stagedSwitch = null;
  console.info(`[panda/acp:${entry.connectionId}] abandoning a staged session switch to ${staged.snapshot.targetSessionId} (${where})`);
  entry.port.invalidateSelections();
  entry.port.rollbackStagedSession(staged.snapshot);
}

// ---------------------------------------------------------------------------
// Public manager surface
// ---------------------------------------------------------------------------

export type LiveConnectOptions = { resume?: boolean; profileId?: string | null };

/**
 * Connects (or reconnects) one connection slot. Connecting an already-live
 * slot replaces its connection — the client's era machinery (issue #19)
 * retires the old one. `profileId` routes the on-success write-back.
 *
 * The workspace (issue #23, ADR 0005) becomes the protocol cwd here — the
 * single derivation point: local-directory sends its path, 无工作区 sends the
 * `WORKSPACE_NONE_CWD` constant. Everything downstream (ConnectionInfo.cwd,
 * session/new) works in derived cwd strings.
 */
export async function connectLiveConnection(
  connectionId: string,
  url: string,
  workspace: Workspace,
  opts?: LiveConnectOptions,
): Promise<void> {
  const trimmedUrl = url.trim();
  const normalizedWorkspace: Workspace =
    workspace.kind === 'local-directory'
      ? { kind: 'local-directory', path: workspace.path.trim() }
      : workspace;
  const cwd = workspaceToCwd(normalizedWorkspace);
  if (!trimmedUrl || !cwd) {
    console.warn(`[panda/acp:${connectionId}] connect ignored: url and a workspace path are required`);
    return;
  }
  remember(URL_KEY, trimmedUrl);
  remember(CWD_KEY, cwd);
  const entry = ensureEntry(connectionId);
  entry.pendingProfile = opts?.profileId
    ? { id: opts.profileId, url: trimmedUrl, workspace: normalizedWorkspace }
    : null;
  usePanda.getState().ensureConnection(connectionId);
  const resumeSessionId = opts?.resume
    ? usePanda.getState().connections[connectionId]?.connection.sessionId ?? null
    : null;
  usePanda.getState().setMode('live');
  entry.port.setConnection({
    status: 'connecting',
    url: trimmedUrl,
    cwd,
    error: null,
    agentName: null,
    protocolVersion: null,
    sessionId: resumeSessionId,
  });
  // Seed the sidebar with sessions remembered for this service; the server
  // list (if any) merges on top. A replacing connect replaces the old
  // endpoint's visible list rather than combining unrelated histories.
  restoreEndpointSessions(trimmedUrl, entry.port.replaceSessions);
  // A replacing connect ends the previous connection era (issue #19): its
  // in-flight switch can never settle — roll it back stale BEFORE the new
  // era begins staging/adopting anything.
  abandonStagedSwitch(entry, 'connect replacing the connection');
  await entry.client.connect(
    new WebSocketTransport(trimmedUrl),
    cwd,
    resumeSessionId ? { sessionId: resumeSessionId } : undefined,
  );
}

/**
 * Disconnects one connection. Profile slots are retained (历史可见、可重连);
 * a 临时直连 ends with its disconnect — slot, documents and all.
 */
export function disconnectLiveConnection(connectionId: string): void {
  const entry = liveConnections.get(connectionId);
  if (!entry) {
    console.warn(`[panda/acp] disconnect ignored: no live connection "${connectionId}"`);
    return;
  }
  entry.client.disconnect();
  if (isDirectConnectionId(connectionId)) {
    removeLiveConnection(connectionId);
  }
}

/**
 * Removes a connection outright (CONTEXT.md 移除): disconnects it and drops
 * its slot with every local document (orphan cleanup). The per-endpoint
 * persisted session list survives — it is the endpoint's memory, not the
 * connection's.
 */
export function removeLiveConnection(connectionId: string): void {
  const entry = liveConnections.get(connectionId);
  if (entry) {
    // The disconnect handlers (abandon switch, status settle) run into the
    // slot first, then closeConnection drops everything they wrote.
    entry.client.disconnect();
    liveConnections.delete(connectionId);
  }
  usePanda.getState().closeConnection(connectionId);
}

/**
 * Foregrounds a connection: the UI pointers move to it (and its settled
 * session) and the unread signal clears. Foregrounding a live connection IS
 * leaving demo mode — the user asked to see this connection's content.
 */
export function foregroundConnection(connectionId: string): void {
  if (!liveConnections.has(connectionId) && !usePanda.getState().connections[connectionId]) {
    console.warn(`[panda/acp] foreground ignored: unknown connection "${connectionId}"`);
    return;
  }
  usePanda.getState().setMode('live');
  usePanda.getState().setActiveConnection(connectionId);
}

/**
 * Previews an Agent 配置 (the sidebar's click action on an unconnected
 * profile): shows its endpoint's remembered sessions without connecting. A
 * slot that already exists (connected, errored, retained) is only
 * foregrounded — its resume affordances must not be clobbered. In demo mode
 * this is a no-op; the form prefill is the UI's business.
 */
export function previewProfileConnection(profile: AgentProfile, storage: SessionStorage = globalThis.localStorage): void {
  if (usePanda.getState().mode !== 'live') return;
  const url = profile.url.trim();
  const cwd = workspaceToCwd(profile.workspace).trim();
  if (!url || !cwd) {
    console.error(`[panda/profiles] selected profile ${profile.id} has an empty url or workspace path`);
    return;
  }
  if (usePanda.getState().connections[profile.id]) {
    foregroundConnection(profile.id);
    return;
  }
  usePanda.getState().ensureConnection(profile.id);
  const entry = ensureEntry(profile.id);
  restoreEndpointSessions(url, entry.port.replaceSessions, storage);
  entry.port.resetDocument();
  entry.port.setCapabilities({ image: false, loadSession: false, list: false, resume: false, delete: false });
  entry.port.setConnection({
    status: 'disconnected',
    url,
    cwd,
    agentName: null,
    protocolVersion: null,
    sessionId: null,
    error: null,
  });
}

/**
 * Opens one session of any connection (sidebar click, issue #21's 双指针
 * 联动): the connection is foregrounded first, then — live connections
 * switch through the transactional session/load (a failure leaves the user
 * on the connection's settled session), while offline slots point the UI at
 * the retained document directly (查看历史 without a protocol round-trip).
 */
export function openLiveSession(connectionId: string, sessionId: string, cwd: string): void {
  const entry = liveConnections.get(connectionId);
  const slot = usePanda.getState().connections[connectionId];
  if (!entry || !slot) {
    console.warn(`[panda/acp] openSession ignored: unknown connection "${connectionId}"`);
    return;
  }
  const connected = slot.connection.status === 'connected';
  if (sessionId === slot.connection.sessionId) {
    // Already the connection's settled session — foregrounding suffices.
    foregroundConnection(connectionId);
    return;
  }
  if (!connected) {
    // Retained documents render read-only; the UI session moves explicitly.
    usePanda.getState().setMode('live');
    usePanda.getState().setActiveConnection(connectionId, sessionId);
    return;
  }
  foregroundConnection(connectionId);
  void entry.client.loadSession(sessionId, cwd);
}

/** Resolves the entry behind a foreground action, loudly tolerating "none". */
function foregroundEntry(action: string): LiveConnection | null {
  const connectionId = usePanda.getState().activeConnectionId;
  if (connectionId === null) {
    console.warn(`[panda/acp] ${action} ignored: no foreground connection`);
    return null;
  }
  const entry = liveConnections.get(connectionId);
  if (!entry) {
    console.warn(`[panda/acp] ${action} ignored: foreground connection "${connectionId}" has no client`);
    return null;
  }
  return entry;
}

export async function sendLive(content: AcpContentBlock[]): Promise<void> {
  const entry = foregroundEntry('send');
  if (entry) await entry.client.send(content);
}

export function resolveLivePermission(toolCallId: string, kind: PermissionOptionKind): void {
  const entry = foregroundEntry('resolvePermission');
  if (entry) entry.client.resolvePermission(toolCallId, kind);
}

/**
 * Answers one pending form-mode `elicitation/create` (submit / decline /
 * cancel) on the foreground connection. The id is the Panda-local mint
 * (`elicit-N`) the request was folded into the document under.
 */
export function resolveLiveElicitation(id: string, response: ElicitationResponse): void {
  const entry = foregroundEntry('resolveElicitation');
  if (entry) entry.client.resolveElicititation(id, response);
}

export function cancelLiveTurn(): void {
  const entry = foregroundEntry('cancel');
  if (entry) entry.client.cancel();
}

/**
 * Switches the foreground connection's session mode (`session/set_mode`).
 * The document updates only on the confirmed RPC / notification (see
 * LiveAcpClient.setMode) — no optimistic flip.
 */
export function setLiveMode(modeId: string): void {
  const entry = foregroundEntry('setMode');
  if (entry) void entry.client.setMode(modeId);
}

export async function newLiveSession(cwd: string): Promise<void> {
  const trimmedCwd = cwd.trim();
  if (!trimmedCwd) {
    console.warn('[panda/acp] newSession ignored: cwd is required');
    return;
  }
  const entry = foregroundEntry('newSession');
  if (!entry) return;
  remember(CWD_KEY, trimmedCwd);
  // The new session adopts a fresh document; the old one is retained.
  await entry.client.newSession(trimmedCwd);
}

/** Deletes a session on any connection (capability-gated in the client). */
export async function deleteLiveSession(
  connectionId: string,
  sessionId: string,
  storage: SessionStorage = globalThis.localStorage,
): Promise<void> {
  const entry = liveConnections.get(connectionId);
  if (!entry) {
    console.warn(`[panda/acp] deleteSession ignored: no live connection "${connectionId}"`);
    return;
  }
  const url = usePanda.getState().connections[connectionId]?.connection.url ?? null;
  await entry.client.deleteSession(sessionId);
  // The endpoint memory must drop it too — the persist union would otherwise
  // resurrect the entry the agent just deleted on the next snapshot.
  if (url) purgePersistedSession(url, sessionId, storage);
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

/** For tests: inject a client factory for a future connection id. */
export function __setClientFactory(connectionId: string, factory: LiveClientFactory): void {
  clientFactories.set(connectionId, factory);
}

/** For tests: a fallback factory for every id without an explicit override. */
export function __setDefaultClientFactory(factory: LiveClientFactory | null): void {
  defaultClientFactory = factory;
}

/** For tests: reset the manager between cases (drops every entry). */
export function __resetLiveConnections(): void {
  for (const entry of [...liveConnections.values()]) {
    entry.client.disconnect();
  }
  liveConnections.clear();
  clientFactories.clear();
  defaultClientFactory = null;
  activePermissionPolicy = alwaysAskPolicy;
}

/** For tests: the live connection ids, in creation order. */
export function __liveConnectionIds(): string[] {
  return [...liveConnections.keys()];
}
