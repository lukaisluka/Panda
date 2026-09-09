import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { t } from './i18n';
import { LiveAcpClient } from './acp/LiveAcpClient';
import { WebSocketTransport } from './acp/transport/WebSocketTransport';
import type {
  AcpAuthMethod,
  AcpConfigOption,
  AcpContentBlock,
  AcpSessionModeState,
  AcpSessionUpdate,
  ElicitationRequest,
  ElicitationResponse,
  PermissionOptionKind,
} from './protocol/types';
import { connectionStorePort, usePanda, type ConnectionStorePort, type SessionEntry, type SessionSwitchSnapshot } from './store';
import {
  canonicalArgs,
  liveTargetEndpoint,
  loadProfiles,
  profileEndpoint,
  profileToLiveTarget,
  updateProfileFields,
  type AgentProfile,
  type LiveTarget,
  type ProfileFieldPatch,
} from './profiles';
import { getStdioTransportFactory, splitArgs } from './acp/transport/stdioHost';
import { loadMcpServers, mcpServersForProfile } from './mcpServers';
import { cwdToWorkspace, workspaceToCwd, type Workspace } from './workspace';
import { alwaysAskPolicy, type PermissionDecision, type PermissionPolicy } from './policy';
import { notifyUser } from './userNotice';

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
  // The persisted list folds FIRST — it is the base layer (#9): entries only
  // the storage remembers (a removed connection's sessions) survive, and
  // every live value folds on top. The fold is incoming-wins with a null
  // fallback, so folding the disk last — as this used to — let a stale
  // persisted updatedAt/title overwrite the fresh live one, freezing every
  // session's last-activity at its first-ever write and feeding the frozen
  // value back into storage (a fixed point the pump could never escape).
  const urls = new Set(
    connections.flatMap((slot) => (slot.url ? [slot.url] : [])),
  );
  for (const url of urls) {
    for (const entry of loadPersistedSessions(url, storage)) fold(url, entry);
  }
  for (const slot of connections) {
    const url = slot.url;
    if (!url) continue;
    for (const entry of slot.sessions) fold(url, entry);
  }
  for (const [url, entries] of byUrl) {
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
  stagedSwitch: { snapshot: SessionSwitchSnapshot; era: number; sessionId: string; cwd: string } | null;
  /** Profile targeted by the in-flight connect — consumed on success (write-back). */
  pendingProfile: { id: string; target: LiveTarget; workspace: Workspace } | null;
  /**
   * The profile this entry connected as (#148): the MCP whitelist is read
   * through it at every session establishment, so checklist edits apply to
   * the next session, like server-definition edits. Null on custom-address
   * direct connections — they carry no MCP.
   */
  profileId: string | null;
  /**
   * The target the entry last connected with (issue #121) — the reconnect
   * flow's source of truth. A stdio endpoint string (`stdio: cmd args`) never
   * parses back into command/args, so the target itself is remembered here;
   * null while the slot was only seeded offline (reconnect then rebuilds it
   * from the profile).
   */
  lastTarget: LiveTarget | null;
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
    profileId: null,
    lastTarget: null,
  };
  const factory =
    clientFactories.get(connectionId) ??
    defaultClientFactory ??
    ((handlers) =>
      new LiveAcpClient(handlers, {
        policy: bindPolicyToConnection(connectionId),
        // The real MCP source (issue #71): read fresh at every session
        // establishment, so config edits apply to the next session. Injected
        // as a provider — the client itself stays storage-free. Since #148
        // the read is filtered through the connecting profile's whitelist
        // (direct connections: none).
        mcpServers: () =>
          mcpServersForProfile(
            loadMcpServers(),
            entry.profileId === null ? null : loadProfiles().find((profile) => profile.id === entry.profileId),
          ),
      }));
  entry.client = factory(wireHandlers(entry));
  liveConnections.set(connectionId, entry);
  return entry;
}

function wireHandlers(entry: LiveConnection) {
  const { connectionId, port } = entry;
  return {
    onUpdate: (update: AcpSessionUpdate) => port.update(update),
    onConnected: (info: { agentName: string; protocolVersion: number }) => {
      port.setConnection({
        status: 'connected',
        agentName: info.agentName,
        protocolVersion: info.protocolVersion,
        error: null,
        authMethods: null,
        authedMethodId: null,
        authElicitation: null,
      });
      // "默认工作区" = what the last successful connect used (issue #2, #23);
      // the endpoint fields echo back as the same-kind patch (issue #121).
      const pending = entry.pendingProfile;
      if (pending) {
        const patch: ProfileFieldPatch = { workspace: pending.workspace };
        if (pending.target.kind === 'websocket') patch.url = pending.target.url;
        else {
          patch.command = pending.target.command;
          patch.args = pending.target.args;
        }
        updateProfileFields(pending.id, patch);
      }
      entry.pendingProfile = null;
    },
    onSessionId: (sessionId: string, cwd: string) => port.adoptSession(sessionId, cwd),
    onSessionModes: (modes: AcpSessionModeState | null) =>
      port.update({ sessionUpdate: 'modes_initialized', modes }),
    onSessionConfigOptions: (options: AcpConfigOption[] | null) =>
      port.update({ sessionUpdate: 'config_options_initialized', options }),
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
          ? { status: 'error', error: reason, authMethods: null, availableAuthMethods: [], authedMethodId: null, authElicitation: null }
          : { status: 'disconnected', error: null, sessionId: null, authMethods: null, availableAuthMethods: [], authedMethodId: null, authElicitation: null },
      );
    },
    // v1 auth_required: the session waits for login; the auth card takes over
    // the main view until a method succeeds (or the failure settles).
    onAuthChallenge: (challenge: { methods: AcpAuthMethod[]; message: string }) => {
      port.setConnection({
        status: 'auth_required',
        authMethods: challenge.methods,
        authElicitation: null,
        error: challenge.message,
      });
    },
    onAuthElicitation: (request: ElicitationRequest | null) => {
      port.setConnection({ authElicitation: request });
    },
    // initialize's standing offer (#90): powers the status-bar auth entry.
    onAuthMethods: (methods: AcpAuthMethod[]) => {
      port.setConnection({ availableAuthMethods: methods });
    },
    // onConnected just nulled the record; a live era settles it right after.
    onAuthenticated: (methodId: string) => {
      port.setConnection({ authedMethodId: methodId });
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
      // sessionId/cwd ride along for the rollback toast's Retry (#217).
      entry.stagedSwitch = { snapshot: port.stageSession(sessionId, cwd), era, sessionId, cwd };
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
        // Name the target session and offer the retry right in the toast
        // (#217): "Session switch failed: Internal error" named nobody and
        // had no way back. The raw reason rides along — protocol errors are
        // developer-facing diagnostics, not noise.
        const sessions = usePanda.getState().connections[connectionId]?.sessions ?? [];
        const title = sessions.find((entry_) => entry_.sessionId === staged.sessionId)?.title ?? staged.sessionId;
        const message = t('live.switchFailedTitled', { title, reason });
        port.setConnection({ error: message });
        // The status-bar banner alone proved too quiet (#160): a failed
        // session/load looks like a dead click unless a toast says why.
        notifyUser('error', message, {
          label: t('live.retrySwitch'),
          run: () => openLiveSession(connectionId, staged.sessionId, staged.cwd),
        });
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
 * The target (issue #121) picks the transport at the AcpTransport seam: a
 * websocket target gets a WebSocketTransport; a stdio target requires a
 * registered host factory (stdioHost) and fails fast as a connection error
 * when the host cannot spawn — never a silent fallback to another transport.
 *
 * The workspace (issue #23, ADR 0005) becomes the protocol cwd here — the
 * single derivation point: local-directory sends its path, 无工作区 sends the
 * `WORKSPACE_NONE_CWD` constant. Everything downstream (ConnectionInfo.cwd,
 * session/new) works in derived cwd strings.
 */
export async function connectLiveConnection(
  connectionId: string,
  target: LiveTarget,
  workspace: Workspace,
  opts?: LiveConnectOptions,
): Promise<void> {
  const normalizedTarget: LiveTarget =
    target.kind === 'websocket'
      ? { kind: 'websocket', url: target.url.trim() }
      : { kind: 'stdio', command: target.command.trim(), args: canonicalArgs(target.args) };
  const normalizedWorkspace: Workspace =
    workspace.kind === 'local-directory'
      ? { kind: 'local-directory', path: workspace.path.trim() }
      : workspace;
  const cwd = workspaceToCwd(normalizedWorkspace);
  const endpoint = liveTargetEndpoint(normalizedTarget);
  if (!endpoint || !cwd) {
    console.warn(`[panda/acp:${connectionId}] connect ignored: an endpoint and a workspace path are required`);
    return;
  }
  const stdioFactory = normalizedTarget.kind === 'stdio' ? getStdioTransportFactory() : null;
  if (normalizedTarget.kind === 'stdio' && !stdioFactory) {
    // §5.2 fail-fast: this host cannot spawn. Surfaced as a connect failure —
    // the same shape the client reports for refused sockets.
    const entry = ensureEntry(connectionId);
    usePanda.getState().ensureConnection(connectionId);
    entry.port.setConnection({ status: 'error', url: endpoint, cwd, error: t('acp.stdioHostMissing') });
    return;
  }
  // The custom-address form prefills from the last WEBSOCKET endpoint only —
  // a stdio command must never leak into it (issue #121).
  if (normalizedTarget.kind === 'websocket') remember(URL_KEY, normalizedTarget.url);
  remember(CWD_KEY, cwd);
  const entry = ensureEntry(connectionId);
  entry.lastTarget = normalizedTarget;
  entry.profileId = opts?.profileId ?? null;
  entry.pendingProfile = opts?.profileId
    ? { id: opts.profileId, target: normalizedTarget, workspace: normalizedWorkspace }
    : null;
  usePanda.getState().ensureConnection(connectionId);
  const resumeSessionId = opts?.resume
    ? usePanda.getState().connections[connectionId]?.connection.sessionId ?? null
    : null;
  usePanda.getState().setMode('live');
  entry.port.setConnection({
    status: 'connecting',
    url: endpoint,
    cwd,
    error: null,
    agentName: null,
    protocolVersion: null,
    sessionId: resumeSessionId,
    availableAuthMethods: [],
    authedMethodId: null,
  });
  // Seed the sidebar with sessions remembered for this endpoint; the server
  // list (if any) merges on top. A replacing connect replaces the old
  // endpoint's visible list rather than combining unrelated histories.
  restoreEndpointSessions(endpoint, entry.port.replaceSessions);
  // A fresh direct dial retires this endpoint's earlier pure-failure temp
  // slots (#221): without the sweep, every retry against a dead address
  // piles one more「Temp」error row onto the sidebar.
  if (isDirectConnectionId(connectionId)) sweepFailedDirectSlots(endpoint, connectionId);
  // A replacing connect ends the previous connection era (issue #19): its
  // in-flight switch can never settle — roll it back stale BEFORE the new
  // era begins staging/adopting anything.
  abandonStagedSwitch(entry, 'connect replacing the connection');
  let transport: import('./acp/transport/AcpTransport').AcpTransport;
  if (normalizedTarget.kind === 'websocket') {
    transport = new WebSocketTransport(normalizedTarget.url);
  } else {
    const factory = stdioFactory;
    if (!factory) {
      // Unreachable behind the fail-fast guard above; loud, never silent.
      throw new Error(`[panda/acp:${connectionId}] stdio connect without a registered transport factory`);
    }
    transport = factory({ program: normalizedTarget.command, args: splitArgs(normalizedTarget.args), cwd });
  }
  await entry.client.connect(
    transport,
    cwd,
    resumeSessionId ? { sessionId: resumeSessionId } : undefined,
  );
}

/**
 * Retires the 临时直连 slots a dead endpoint left behind (#221): a slot
 * qualifies only as a PURE failure — errored, never held a session, no
 * retained documents — so live, connecting, resumable or history-carrying
 * slots are never swept. Called at the start of a fresh direct dial to the
 * same endpoint; the dialing slot itself is exempt.
 */
export function sweepFailedDirectSlots(endpoint: string, keepConnectionId: string): void {
  const stale = Object.entries(usePanda.getState().connections).filter(([id, slot]) =>
    id !== keepConnectionId &&
    isDirectConnectionId(id) &&
    slot.connection.url === endpoint &&
    slot.connection.status === 'error' &&
    slot.connection.sessionId === null &&
    Object.keys(slot.docs).length === 0,
  );
  for (const [id] of stale) {
    console.info(`[panda/acp] sweeping failed temp slot ${id} (${endpoint})`);
    removeLiveConnection(id);
  }
}

/** A test-connection's verdict (#221): the handshake either answered with
 * the agent's identity, or failed with connect-chain copy — the same
 * attribution (#217) the sidebar error block shows on a real connect. */
export type LiveTargetProbe =
  | { ok: true; agentName: string; protocolVersion: number }
  | { ok: false; error: string };

/** Test seam: overrides the probe's transport construction (node has no
 * WebSocket — tests inject an in-memory stream transport). Null restores
 * the real derivation. */
let testTransportFactory: ((target: LiveTarget, cwd: string) => import('./acp/transport/AcpTransport').AcpTransport) | null = null;

/** For tests: install/clear the probe transport factory. */
export function __setTestTransportFactory(
  factory: ((target: LiveTarget, cwd: string) => import('./acp/transport/AcpTransport').AcpTransport) | null,
): void {
  testTransportFactory = factory;
}

/**
 * Dials an endpoint, runs the initialize handshake, and drops the link —
 * the profile form's「测试连接」. No store slot, no session, no sidebar
 * footprint: the verdict arrives through the return value only. Runs the
 * same connect chain as a real connect, so transport failures, protocol
 * mismatches and timeouts surface with their established copy.
 *
 * The connect is RACED against the verdict: a refused handshake leaves
 * connect() suspended forever (initialize hangs on the dead link — the
 * #217 attribution arrives through onDisconnected instead of the await),
 * and a test button must always settle.
 */
export async function testLiveTarget(target: LiveTarget, workspace: Workspace): Promise<LiveTargetProbe> {
  const normalizedTarget: LiveTarget =
    target.kind === 'websocket'
      ? { kind: 'websocket', url: target.url.trim() }
      : { kind: 'stdio', command: target.command.trim(), args: canonicalArgs(target.args) };
  const endpoint = liveTargetEndpoint(normalizedTarget);
  const cwd = workspaceToCwd(
    workspace.kind === 'local-directory' ? { kind: 'local-directory', path: workspace.path.trim() } : workspace,
  );
  if (!endpoint || !cwd) return { ok: false, error: t('acp.testMissingEndpoint') };
  const stdioFactory = normalizedTarget.kind === 'stdio' ? getStdioTransportFactory() : null;
  if (normalizedTarget.kind === 'stdio' && !stdioFactory) {
    return { ok: false, error: t('acp.stdioHostMissing') };
  }
  // The outcome lands through the same handlers a real connect reports on —
  // onConnected settles success, onDisconnected(reason) the failure copy.
  let outcome: LiveTargetProbe = { ok: false, error: t('acp.testNoOutcome') };
  let settled!: () => void;
  const verdictArrived = new Promise<void>((resolve) => {
    settled = resolve;
  });
  const record = (verdict: LiveTargetProbe) => {
    outcome = verdict;
    settled();
  };
  const probe = new LiveAcpClient({
    onUpdate: () => {},
    onConnected: (info) => {
      record({ ok: true, agentName: info.agentName, protocolVersion: info.protocolVersion });
    },
    onSessionId: () => {},
    onSessionModes: () => {},
    onSessionConfigOptions: () => {},
    onDisconnected: (reason) => {
      if (reason) record({ ok: false, error: reason });
    },
    onAuthChallenge: (challenge) => {
      record({ ok: false, error: challenge.message });
    },
    onAuthElicitation: () => {},
    onCapabilities: () => {},
    onAuthMethods: () => {},
    onAuthenticated: () => {},
    onSessions: () => {},
    onSessionInfo: () => {},
    onReplayStart: () => {},
    onSessionDeleted: () => {},
    onSessionSwitchStage: () => {},
    onSessionSwitchCommit: () => {},
    onSessionSwitchRollback: () => {},
  });
  try {
    const transport: import('./acp/transport/AcpTransport').AcpTransport = testTransportFactory
      ? testTransportFactory(normalizedTarget, cwd)
      : normalizedTarget.kind === 'websocket'
        ? new WebSocketTransport(normalizedTarget.url)
        : stdioFactory!({ program: normalizedTarget.command, args: splitArgs(normalizedTarget.args), cwd });
    await Promise.race([probe.connect(transport, cwd, { probe: true }), verdictArrived]);
  } catch (err) {
    // connect() reports failures through onDisconnected and never throws —
    // anything escaping here is a programming error, surfaced not swallowed.
    console.error('[panda/acp] test connection threw', err);
    return { ok: false, error: t('acp.connectFailed', { error: String(err) }) };
  } finally {
    // Tearing down settles every leftover shape: a hanging refused-dial era,
    // and a half-open wire after a mid-handshake failure.
    probe.disconnect();
  }
  return outcome;
}

/**
 * The target a reconnect should dial (issue #121): the entry's remembered
 * last target, else the profile's current target for an offline-seeded slot.
 * Null when neither exists (an unknown or direct slot that never connected).
 */
export function reconnectTargetFor(connectionId: string): LiveTarget | null {
  const remembered = liveConnections.get(connectionId)?.lastTarget ?? null;
  if (remembered) return remembered;
  if (isDirectConnectionId(connectionId)) return null;
  const profile = loadProfiles().find((entry) => entry.id === connectionId) ?? null;
  return profile ? profileToLiveTarget(profile) : null;
}

/** Reconnect tuning — form edits ride along; the target slot is named by the
 * caller (bug hunt #1: an error block's buttons reconnect THAT slot, never
 * the healthy foreground). */
export type ReconnectOptions = {
  /** The slot to reconnect; omitted means the foreground. */
  connectionId?: string;
  /** Resume the slot's retained session (transcript kept) instead of a fresh one. */
  resume?: boolean;
  /** Form-edited WEBSOCKET endpoint; omitted ones fall back to the remembered
   * target. Ignored (loudly) for stdio targets — their command edits live in
   * the settings editor. */
  url?: string;
  workspace?: Workspace;
};

/**
 * Reconnects one slot by id. Everything the target remembers (endpoint,
 * workspace) is reused unless overridden — same establishment chain as a
 * fresh connect (`connectLiveConnection`). Every ignored exit answers the
 * click with a toast (#238): an ignored REQUEST is an operation-level
 * failure, while the dial's own failure keeps its error card — the console
 * warn alone read as a dead button.
 */
export function reconnectLiveConnection(
  connectionId: string | null,
  opts?: Omit<ReconnectOptions, 'connectionId'>,
): void {
  if (connectionId === null) {
    console.warn('[panda/acp] reconnect ignored: no target connection');
    notifyUser('error', t('acp.notice.reconnectNoConnection'));
    return;
  }
  const state = usePanda.getState();
  // A stdio endpoint string never parses back into command/args — the
  // remembered target (or the profile, for offline-seeded slots) is the
  // reconnect's source of truth (issue #121).
  const remembered = reconnectTargetFor(connectionId);
  if (!remembered) {
    console.warn(`[panda/acp] reconnect ignored: slot "${connectionId}" has no remembered target`);
    notifyUser('error', t('acp.notice.reconnectNoTarget'));
    return;
  }
  const target: LiveTarget =
    opts?.url !== undefined
      ? remembered.kind === 'websocket'
        ? { kind: 'websocket', url: opts.url.trim() || remembered.url }
        : (console.warn('[panda/acp] reconnect ignored the url edit on a stdio target — edit the profile instead'), remembered)
      : remembered;
  // The slot remembers the derived cwd it last used; `/` reads back as
  // 无工作区 (ADR 0005's accepted equivalence).
  const slot = state.connections[connectionId];
  const workspace = opts?.workspace ?? (slot?.connection.cwd != null ? cwdToWorkspace(slot.connection.cwd) : null);
  if (!workspace) {
    console.warn(`[panda/acp] reconnect ignored: slot "${connectionId}" has no remembered workspace`);
    notifyUser('error', t('acp.notice.reconnectNoWorkspace'));
    return;
  }
  const profileId = isDirectConnectionId(connectionId) ? null : connectionId;
  void connectLiveConnection(connectionId, target, workspace, { resume: opts?.resume, profileId });
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
 * Seeds an offline section for every Agent 配置 (IA refactor phase 3): a
 * disconnected slot carrying the endpoint's remembered sessions, without
 * connecting and without claiming the foreground. Slots that already exist
 * (connected, errored, retained) are left untouched — their resume
 * affordances must not be clobbered. Called by the sidebar whenever its
 * profile list changes; profiles whose slot died return on the next call.
 */
export function seedProfileSlots(profiles: AgentProfile[], storage: SessionStorage = globalThis.localStorage): void {
  for (const profile of profiles) {
    if (usePanda.getState().connections[profile.id]) continue;
    const endpoint = profileEndpoint(profile);
    const cwd = workspaceToCwd(profile.workspace).trim();
    if (!endpoint || !cwd) {
      console.error(`[panda/profiles] seed skipped: profile ${profile.id} has an empty endpoint or workspace path`);
      continue;
    }
    usePanda.getState().seedConnection(profile.id);
    const entry = ensureEntry(profile.id);
    restoreEndpointSessions(endpoint, entry.port.replaceSessions, storage);
    entry.port.resetDocument();
    entry.port.setCapabilities({ image: false, loadSession: false, list: false, resume: false, delete: false });
    entry.port.setConnection({
      status: 'disconnected',
      url: endpoint,
      cwd,
      agentName: null,
      protocolVersion: null,
      sessionId: null,
      availableAuthMethods: [],
      authedMethodId: null,
      error: null,
    });
  }
}

/**
 * Reconciles the store's connection topology with the profile list (#61):
 * seed a disconnected slot (remembered sessions included) for every 配置 and
 * drop slots whose 配置 was deleted — remembered sessions live per-endpoint
 * in storage and survive both. The Sidebar mounts this on profile changes;
 * the topology policy lives here, not in the component.
 */
export function reconcileProfileSlots(profiles: AgentProfile[]): void {
  seedProfileSlots(profiles);
  const known = new Set(profiles.map((profile) => profile.id));
  for (const connectionId of Object.keys(usePanda.getState().connections)) {
    if (!isDirectConnectionId(connectionId) && !known.has(connectionId)) removeLiveConnection(connectionId);
  }
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
    notifyUser('error', t('live.notice.unknownConnection'));
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
 * Runs one login method on the foreground connection (v1 `authenticate`),
 * then re-establishes the session — the connect flow's auth_required
 * recovery. LiveAcpClient owns the retry; the store settles via the usual
 * onConnected / onAuthChallenge handlers.
 */
export function authenticateLiveConnection(methodId: string): void {
  const entry = foregroundEntry('authenticate');
  if (entry) void entry.client.authenticate(methodId);
}

/** v1 `logout` on the foreground connection (gated by auth.logout). */
export function logoutLiveConnection(): void {
  const entry = foregroundEntry('logout');
  if (entry) void entry.client.logout();
}

/**
 * Answers one pending `elicitation/create` (form submit/decline, url decline
 * / cancel) on the foreground connection. Form ids are Panda-local mints
 * (`elicit-N`); url ids are the wire's opaque elicitationIds.
 */
export function resolveLiveElicitation(id: string, response: ElicitationResponse): void {
  const entry = foregroundEntry('resolveElicitation');
  if (entry) entry.client.resolveElicitation(id, response);
}

/**
 * Consents to a url-mode elicitation on the foreground connection: answers
 * the RPC accept. The window itself is opened by the card, synchronously in
 * the click gesture — an async window.open would be popup-blocked.
 */
export function openLiveElicitationUrl(id: string): void {
  const entry = foregroundEntry('openElicitationUrl');
  if (entry) entry.client.openElicitationUrl(id);
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

/**
 * Writes one session config option on the foreground connection
 * (`session/set_config_option`). Like setLiveMode, confirmation-driven — the
 * document moves only when the resolved response's list comes back.
 */
export function setLiveConfigOption(configId: string, value: string | boolean): void {
  const entry = foregroundEntry('setConfigOption');
  if (entry) void entry.client.setConfigOption(configId, value);
}

export async function newLiveSession(cwd: string, connectionId?: string): Promise<void> {
  const trimmedCwd = cwd.trim();
  if (!trimmedCwd) {
    console.warn('[panda/acp] newSession ignored: cwd is required');
    return;
  }
  // Row-level callers name their connection (bug hunt #5): the session is
  // created on THAT agent and the foreground follows it — never on whatever
  // connection happens to hold the foreground.
  const entry = connectionId
    ? liveConnections.get(connectionId) ?? null
    : foregroundEntry('newSession');
  if (!entry) {
    if (connectionId) console.warn(`[panda/acp] newSession ignored: no live connection "${connectionId}"`);
    return;
  }
  if (connectionId) foregroundConnection(connectionId);
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
    notifyUser('error', t('live.notice.unknownConnection'));
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
