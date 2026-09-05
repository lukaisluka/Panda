import {
  PROTOCOL_VERSION,
  RequestError,
  client,
  methods,
  type AgentCapabilities,
  type AuthMethod,
  type ClientConnection,
  type CompleteElicitationNotification,
  type ContentBlock,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type InitializeResponse,
  type ListSessionsResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import type { AcpTransport } from './transport/AcpTransport';
import type {
  AcpAuthMethod,
  AcpConfigOption,
  AcpContentBlock,
  AcpSessionModeState,
  AcpSessionUpdate,
  ElicitationRequest,
  ElicitationResponse,
  PermissionOptionKind,
  PermissionResponse,
} from '../protocol/types';
import {
  echoRelation,
  parseSessionNotification,
  removeSdkStrictSessionUpdateRouter,
  toAcpUpdates,
  toConfigOptions,
  toElicitationFormRequest,
  toElicitationUrlRequest,
  toPermissionRequest,
  toSessionModeState,
} from './wire';
import { PANDA_HOST_CAPABILITIES, effectiveCapability, type AgentCapabilityDeclarations, type CapabilityKey, type EffectiveCapability } from '../capabilities';
import { alwaysAskPolicy, denyResolution, UNKNOWN_POLICY_CONTEXT, type PermissionDecision } from '../policy';

/**
 * Live ACP client (Phase 1+2): speaks v1 ACP over an injected `AcpTransport`
 * (issue #20) to an already-running ACP service — Panda never spawns or
 * manages the agent process, it only consumes the protocol. The transport is
 * caller-injected, so nothing in this class knows whether the wire is a
 * browser WebSocket, stdio or anything else.
 *
 * Feeds the same handlers the replay driver feeds (update / status /
 * permission) plus connection and session bookkeeping, so the store wiring
 * stays symmetrical between the two drivers.
 *
 * v1 semantics are synthesized here: `session/prompt` stays pending for the
 * whole turn, so the client itself drives running → requires_action → idle.
 * (v2's state_update notifications will slot in at this same seam.)
 *
 * Session lifecycle (Phase 2): capabilities gate everything; reconnect prefers
 * `session/resume` (transcript preserved, no replay), falls back to
 * `session/load` (history replayed onto a clean document), else starts fresh.
 *
 * Session switches are transactional (issue #17): `session/load` stages the
 * target first and commits only on success — a failure rolls the client's
 * routing and the driver's snapshot back, so the previous session stays
 * fully rendered and the switch is retryable. The settled pointer semantics:
 * `connection.sessionId` / `activeSessionId` only move on commit.
 */

/** Capability gates as advertised by the agent at initialize (v1) — an alias
 * of the composition module's declarations type (issue #22), so the five
 * keys cannot drift between the client and the decision point. */
export type AgentCaps = AgentCapabilityDeclarations;

export type SessionSummary = {
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: string | null;
};

export type LiveClientHandlers = {
  onUpdate(update: AcpSessionUpdate): void;
  onConnected(info: { agentName: string; protocolVersion: number }): void;
  onSessionId(sessionId: string, cwd: string): void;
  /**
   * Session modes from a session/new · session/load result (null = the agent
   * advertises none). Not emitted on resume: v1's ResumeSessionResponse
   * carries no modes, so the document keeps whatever it already had.
   */
  onSessionModes(modes: AcpSessionModeState | null): void;
  /**
   * Session config options from a session/new · session/load result (null =
   * the agent advertises none; a malformed list is warned and treated as
   * none). Like modes, not emitted on resume — v1's ResumeSessionResponse
   * carries no configOptions.
   */
  onSessionConfigOptions(options: AcpConfigOption[] | null): void;
  /** null reason = clean disconnect; a string = failure shown to the user. */
  onDisconnected(reason: string | null): void;
  /**
   * `session/new` (or resume/load) was rejected with auth_required (-32000):
   * the transport and initialize are fine, the session waits for login. The
   * connection stays open so `authenticate` can run. Empty methods = the
   * agent demands auth but offered nothing a web client can run.
   */
  onAuthChallenge(challenge: { methods: AcpAuthMethod[]; message: string }): void;
  /**
   * A request-scoped (pre-session) elicitation — auth-phase user input (url
   * OAuth flow or a form, e.g. an API key). Latest-wins; null clears it.
   */
  onAuthElicitation(request: ElicitationRequest | null): void;
  onCapabilities(caps: AgentCaps): void;
  /** Server-side session list (session/list, all pages). */
  onSessions(entries: SessionSummary[]): void;
  /** Live session metadata (session_info_update); undefined fields = untouched. */
  onSessionInfo(sessionId: string, info: { title?: string | null; updatedAt?: string | null }): void;
  /** Emitted right before a session/load replay rebuilds the document. */
  onReplayStart(): void;
  onSessionDeleted(sessionId: string): void;
  // -- transactional session switch (issue #17) --------------------------------
  /**
   * A session/load switch begins: the driver stages the target session
   * (routes document writes to it, snapshots the pre-state) and the replay
   * reset follows via `onReplayStart`. The settled pointer does not move yet.
   * `era` is the client's connectionGeneration at transaction start — the
   * driver matches it before consuming commit/rollback (issue #19), so a
   * dead era's late settle can never consume a live era's snapshot.
   */
  onSessionSwitchStage(sessionId: string, cwd: string, era: number): void;
  /** The switch's session/load resolved — the driver commits the staged target. */
  onSessionSwitchCommit(era: number): void;
  /** The switch's session/load failed — the driver rolls back to the snapshot. */
  onSessionSwitchRollback(reason: string, era: number): void;
};

/**
 * Client options (issue #22). `policy` is consulted for every
 * `session/request_permission` before it hangs for the user — the
 * connection layer binds the connection context (connectionId, url) into
 * it, because the client itself knows neither.
 */
export type LiveClientOptions = {
  policy?: (request: RequestPermissionRequest) => PermissionDecision;
};

type PendingPermission = {
  wireOptions: RequestPermissionRequest['options'];
  resolve: (response: RequestPermissionResponse) => void;
};

type PendingElicitation = {
  /** Session elicitations settle into the document; auth-phase (request-
   * scoped) ones clear the connection-level challenge card instead. */
  scope: 'session' | 'auth';
  resolve: (response: CreateElicitationResponse) => void;
};

/**
 * Echo reconciliation state for the outbound message of the in-flight turn
 * (issue #15): the agent's `user_message_chunk` echo is compared against what
 * `send()` dispatched optimistically. Equal → the optimistic block is
 * protocol-confirmed; different or boundary-closed → the buffered echo is
 * re-dispatched as real events and renders separately (never merged, never
 * tampered). Modeled on react-acp's PendingOutbound.
 */
type PendingOutbound = {
  prompt: AcpContentBlock[];
  /** Echo notifications held while the relation is still `prefix`. */
  buffered: SessionNotification[];
  /** Protocol messageId seen on the first echo chunk, if the agent sent one. */
  protocolMessageId?: string;
  /** Echo window closed (matched, diverged, or boundary passed) — pass through. */
  echoWindowClosed: boolean;
};

/** Keep in sync with package.json. */
const CLIENT_INFO = { name: 'panda', title: 'Panda', version: '0.1.0' } as const;

/**
 * A new/load/set_config_option result's `configOptions` → UI model. Absent
 * (undefined/null) means "the agent advertises none" (null); present but
 * malformed is a protocol violation on the agent — warn loudly and treat as
 * none rather than rendering settings that don't match the agent.
 */
function sessionConfigOptions(list: unknown, source: string): AcpConfigOption[] | null {
  if (list === undefined || list === null) return null;
  const options = toConfigOptions(list);
  if (options === null) {
    console.warn(`[panda/acp] ${source} returned a malformed configOptions list — treated as none`);
    return null;
  }
  return options;
}

/**
 * Human-readable message for any thrown value — the SDK rejects pending
 * requests with raw WebSocket `error` Events, which stringify to
 * "[object Event]" and would tell the user nothing.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null) {
    const type = (err as { type?: unknown }).type;
    if (typeof type === 'string') return `WebSocket ${type}`;
    return JSON.stringify(err);
  }
  return String(err);
}

/** v1 capability gates: loadSession is top-level, the rest live under sessionCapabilities. */
function readCaps(caps: AgentCapabilities | null | undefined): AgentCaps {
  const session = caps?.sessionCapabilities;
  return {
    image: caps?.promptCapabilities?.image === true,
    loadSession: caps?.loadSession === true,
    list: session?.list != null,
    resume: session?.resume != null,
    delete: session?.delete != null,
  };
}

/**
 * Whitelists initialize's authMethods to the agent-managed variant. The
 * terminal variant means "run the agent program in a TUI" — Panda never
 * advertises the terminal auth capability, so a compliant agent sends none;
 * a violating one gets them filtered with a warn instead of a dead button.
 */
function toAuthMethods(list: AuthMethod[] | null | undefined): AcpAuthMethod[] {
  if (list == null) return [];
  const methods: AcpAuthMethod[] = [];
  for (const entry of list) {
    if ((entry as { type?: unknown }).type === 'terminal') {
      console.warn(`[panda/acp] terminal auth method "${entry.name}" is not runnable in a web client — filtered`);
      continue;
    }
    methods.push({
      id: entry.id,
      name: entry.name,
      description: entry.description ?? undefined,
    });
  }
  return methods;
}

/** v1 auth_required: the JSON-RPC code RequestError.authRequired mints. */
function isAuthRequired(err: unknown): boolean {
  return err instanceof RequestError && err.code === -32000;
}

export class LiveAcpClient {
  private readonly handlers: LiveClientHandlers;
  /** Host-side permission policy (issue #22); default hands every decision to the user. */
  private readonly policy: (request: RequestPermissionRequest) => PermissionDecision;
  private connection: ClientConnection | null = null;
  /**
   * The transport of the most recent connect attempt (issue #20) — owned
   * before its `connect()` resolves, so a cleanup during a pending open
   * still tears that attempt down.
   */
  private transport: AcpTransport | null = null;
  private sessionId: string | null = null;
  private capabilities: AgentCaps = {
    image: false,
    loadSession: false,
    list: false,
    resume: false,
    delete: false,
  };
  private pendingPrompt: Promise<unknown> | null = null;
  private pendingOutbound: PendingOutbound | null = null;
  /**
   * Concurrent `session/request_permission` waiters (issue #18), keyed
   * `${sessionId}:${toolCallId}` — each hangs independently; overlapping
   * requests for different tools no longer cancel each other.
   */
  private permissionWaiters = new Map<string, PendingPermission>();
  /** Pending elicitations keyed by the Panda-local request id. */
  private elicitationWaiters = new Map<string, PendingElicitation>();
  /** Agent-managed login methods from initialize (-32000 recovery). */
  private authMethods: AcpAuthMethod[] = [];
  /** Whether the agent advertised `auth.logout` — gates the logout method. */
  private agentSupportsLogout = false;
  /** session/close advertised (sessionCapabilities.close) — sent before teardown. */
  private agentSupportsClose = false;
  /** initialize's identity, cached to settle onConnected after authenticate. */
  private initInfo: { agentName: string; protocolVersion: number } | null = null;
  /** cwd of the last connect/newSession — authenticate retries with it. */
  private lastCwd: string | null = null;
  /** Local id mint for elicitation/create requests (form mode carries no wire id). */
  private elicitationSeq = 0;
  /** A transactional session/load switch is in flight (issue #17). */
  private sessionSwitch = false;
  /**
   * Connection era counter (issue #19): bumped by every cleanup — i.e. every
   * connect (which replaces any prior connection) and every disconnect.
   * Async flows and Agent→Client handlers capture it at entry; a mismatch
   * means the era was superseded and the result must be dropped, so a dead
   * connection can never pollute the next one's state.
   */
  private connectionGeneration = 0;
  private disconnectReported = false;

  constructor(handlers: LiveClientHandlers, options: LiveClientOptions = {}) {
    this.handlers = handlers;
    // Single-sourced default (policy.ts): the context-bound seam carries no
    // connection identity, so the unknown context stands in — alwaysAskPolicy
    // ignores it, and real policies arrive pre-bound by the connection layer.
    this.policy = options.policy ?? ((request) => alwaysAskPolicy(request, UNKNOWN_POLICY_CONTEXT));
  }

  /**
   * Connects and establishes a session: transport open → initialize (+
   * capabilities, session list) → resume / load / new. Failures — including
   * transport-level ones — are reported through `onDisconnected`, never
   * thrown; the connection state in the store is the source of truth for
   * the UI.
   */
  async connect(transport: AcpTransport, cwd: string, resume?: { sessionId: string }): Promise<void> {
    // Replace any prior connection silently — its close handler is muted by
    // the connection-identity check below, and its era by the generation
    // counter (issue #19).
    this.cleanupConnection();
    this.disconnectReported = false;
    const generation = this.connectionGeneration;
    this.transport = transport;

    /** True while this connect's era is still the current one. */
    const isCurrent = () => generation === this.connectionGeneration;
    let connection: ClientConnection | null = null;
    /** A superseded connect's result: close quietly, never report — the newer era owns the state. */
    const discardSuperseded = (where: string) => {
      console.info(`[panda/acp] connect superseded by a newer connection (${where}) — discarded`);
      connection?.close();
      transport.disconnect();
    };

    try {
      // The transport seam (issue #20): stream acquisition lives inside the
      // try — a transport-level failure (invalid URL, refused socket)
      // reports as a connect failure instead of an unhandled rejection.
      const stream = await transport.connect();
      if (!isCurrent()) {
        discardSuperseded('transport open');
        return;
      }
      const app = client({ name: 'panda' });
      // The SDK's built-in session/update router strictly zod-parses before any
      // handler runs and drops schema-invalid notifications (unknown kinds) —
      // remove it so the lenient parser below is the only parse seam.
      removeSdkStrictSessionUpdateRouter(app);
      connection = app
        .onNotification(
          methods.client.session.update,
          parseSessionNotification,
          (ctx) => {
            // Second line of defense above the session filter (issue #19): a
            // replaced connection may still drain buffered messages while its
            // socket winds down — those belong to a dead era and are dropped.
            if (generation !== this.connectionGeneration) {
              console.warn('[panda/acp] session/update from a superseded connection — dropped');
              return;
            }
            this.handleUpdate(ctx.params);
          },
        )
        .onNotification(methods.client.elicitation.complete, (ctx) => {
          if (generation !== this.connectionGeneration) {
            console.warn('[panda/acp] elicitation/complete from a superseded connection — dropped');
            return;
          }
          this.handleElicitationComplete(ctx.params);
        })
        .onRequest(methods.client.session.requestPermission, (ctx) => {
          if (generation !== this.connectionGeneration) {
            console.warn(
              '[panda/acp] session/request_permission from a superseded connection — answered cancelled',
            );
            return Promise.resolve({ outcome: { outcome: 'cancelled' } });
          }
          return this.handlePermissionRequest(ctx.params, ctx.signal);
        })
        .onRequest(methods.client.elicitation.create, (ctx) => {
          if (generation !== this.connectionGeneration) {
            console.warn('[panda/acp] elicitation/create from a superseded connection — answered cancel');
            return Promise.resolve({ action: 'cancel' });
          }
          return this.handleElicitationCreate(ctx.params, ctx.signal);
        })
        .connect(stream);
      this.connection = connection;
      // Only an *unexpected* close reports a disconnect — a replaced or already
      // cleaned-up connection no longer owns `this.connection`.
      connection.closed
        .catch(() => {})
        .then(() => {
          if (this.connection === connection) this.reportDisconnect('与服务器的连接已断开');
        });

      const init: InitializeResponse = await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        // Both elicitation modes are implemented — advertising per-mode keeps
        // spec-compliant agents from sending what Panda cannot render. The
        // same goes for boolean config options (select is always allowed),
        // ID-addressed compaction updates (folded per compactionId), and the
        // UNSTABLE plan_update/plan_removed kinds (items variant renders in
        // the plan dock; file/markdown degrade to unsupported blocks).
        clientCapabilities: {
          elicitation: { form: {}, url: {} },
          session: { configOptions: { boolean: {} }, compaction: {} },
          plan: {},
        },
        clientInfo: CLIENT_INFO,
      });
      if (!isCurrent()) {
        discardSuperseded('initialize');
        return;
      }
      if (init.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(
          `agent 协商了协议 v${init.protocolVersion}，Panda 目前只支持 v${PROTOCOL_VERSION}`,
        );
      }
      const agentName = init.agentInfo?.title ?? init.agentInfo?.name ?? 'unknown agent';

      this.capabilities = readCaps(init.agentCapabilities);
      this.authMethods = toAuthMethods(init.authMethods);
      this.agentSupportsLogout = init.agentCapabilities?.auth?.logout != null;
      this.agentSupportsClose = init.agentCapabilities?.sessionCapabilities?.close != null;
      this.initInfo = { agentName, protocolVersion: init.protocolVersion };
      this.lastCwd = cwd;
      this.handlers.onCapabilities(this.capabilities);
      if (this.can('list')) await this.fetchSessionList(connection, generation);
      if (!isCurrent()) {
        discardSuperseded('session list');
        return;
      }

      if (resume?.sessionId) {
        if (this.can('resume')) {
          // Transcript stays as-is: the agent context resumes without replay.
          this.sessionId = resume.sessionId;
          this.handlers.onSessionId(resume.sessionId, cwd);
          await connection.agent.request(methods.agent.session.resume, {
            sessionId: resume.sessionId,
            cwd,
          });
          if (!isCurrent()) {
            discardSuperseded('resume');
            return;
          }
          console.info(`[panda/acp] resumed session ${resume.sessionId} (transcript kept)`);
        } else if (this.can('loadSession')) {
          await this.loadSessionInternal(connection, resume.sessionId, cwd, generation);
          if (!isCurrent()) {
            discardSuperseded('load');
            return;
          }
          console.info(`[panda/acp] reconnected via session/load replay: ${resume.sessionId}`);
        } else {
          console.warn('[panda/acp] agent 不支持会话恢复（resume/loadSession 均未声明）— 已新建会话');
          await this.establishSession(connection, cwd, generation);
        }
      } else {
        await this.establishSession(connection, cwd, generation);
      }

      if (!isCurrent()) {
        discardSuperseded('session established');
        return;
      }
      this.handlers.onConnected({ agentName, protocolVersion: init.protocolVersion });
      console.info(`[panda/acp] connected: ${agentName} (protocol v${init.protocolVersion})`);
    } catch (err) {
      if (!isCurrent()) {
        // The transport of a replaced connection died — expected, not an
        // error of the newer era; reporting it would clobber the new state.
        console.info('[panda/acp] superseded connect failed after replacement — failure discarded');
        return;
      }
      if (isAuthRequired(err) && this.authMethods.length > 0) {
        // The wire is fine, the session is gated on login: keep the
        // connection open and hand the methods to the user (v1 auth).
        this.handlers.onAuthChallenge({ methods: this.authMethods, message: describeError(err) });
        return;
      }
      if (isAuthRequired(err)) {
        this.reportDisconnect('agent 要求认证，但没有提供浏览器可用的登录方式');
        return;
      }
      console.error('[panda/acp] connect failed', err);
      this.reportDisconnect(`连接失败: ${describeError(err)}`);
    }
  }

  /** Sends `session/new` on the live connection and adopts the new session. */
  async newSession(cwd: string): Promise<void> {
    const connection = this.connection;
    const generation = this.connectionGeneration;
    if (!connection) {
      console.warn('[panda/acp] newSession ignored: not connected');
      return;
    }
    if (this.sessionSwitch) {
      console.warn('[panda/acp] newSession ignored: a session switch is still in flight');
      return;
    }
    this.lastCwd = cwd;
    try {
      await this.establishSession(connection, cwd, generation);
    } catch (err) {
      if (generation !== this.connectionGeneration) {
        // The request outlived its era (a reconnect replaced the connection
        // and rejected it): the failure belongs to a dead era — reporting it
        // would kill the new connection's state.
        console.info('[panda/acp] superseded newSession failed after replacement — failure discarded');
        return;
      }
      if (isAuthRequired(err) && this.authMethods.length > 0) {
        // Credentials can expire mid-connection; the login card replaces the
        // composer until a method succeeds.
        this.handlers.onAuthChallenge({ methods: this.authMethods, message: describeError(err) });
        return;
      }
      console.error('[panda/acp] session/new failed', err);
      this.reportDisconnect(`新建会话失败: ${describeError(err)}`);
    }
  }

  /**
   * Runs one agent-managed login method (v1 `authenticate`) and re-attempts
   * session establishment on success. While the RPC is pending the agent may
   * send a request-scoped url elicitation (OAuth link) — it renders on the
   * auth card via onAuthElicitation.
   */
  async authenticate(methodId: string): Promise<void> {
    const connection = this.connection;
    const generation = this.connectionGeneration;
    if (!connection) {
      console.warn('[panda/acp] authenticate ignored: not connected');
      return;
    }
    if (!this.authMethods.some((method) => method.id === methodId)) {
      console.warn(`[panda/acp] authenticate ignored: unknown method id "${methodId}"`);
      return;
    }
    try {
      await connection.agent.request(methods.agent.authenticate, { methodId });
      if (generation !== this.connectionGeneration) {
        console.info('[panda/acp] superseded authenticate completed after replacement — discarded');
        return;
      }
      await this.establishSession(connection, this.lastCwd ?? '/', generation);
      if (generation !== this.connectionGeneration) return;
      // establishSession superseded-returns silently; only a live era settles.
      if (this.initInfo) this.handlers.onConnected(this.initInfo);
      this.handlers.onAuthElicitation(null);
      console.info(`[panda/acp] authenticated via "${methodId}", session established`);
    } catch (err) {
      if (generation !== this.connectionGeneration) {
        console.info('[panda/acp] superseded authenticate failed after replacement — failure discarded');
        return;
      }
      if (isAuthRequired(err) && this.authMethods.length > 0) {
        // Still (or again) locked out — the card stays up for another pick.
        this.handlers.onAuthChallenge({ methods: this.authMethods, message: describeError(err) });
        return;
      }
      console.error('[panda/acp] authenticate failed', err);
      this.reportDisconnect(`登录失败: ${describeError(err)}`);
    }
  }

  /**
   * v1 `logout` — only when the agent advertised `auth.logout`. Fire-and-
   * report: logging out never tears the connection down; the next session/new
   * will surface a fresh auth challenge if the agent requires one.
   */
  async logout(): Promise<void> {
    const connection = this.connection;
    if (!connection) {
      console.warn('[panda/acp] logout ignored: not connected');
      return;
    }
    if (!this.agentSupportsLogout) {
      console.warn('[panda/acp] logout ignored: agent did not advertise auth.logout');
      return;
    }
    try {
      await connection.agent.request(methods.agent.logout, {});
      console.info('[panda/acp] logged out');
    } catch (err) {
      console.error('[panda/acp] logout failed', err);
    }
  }

  /**
   * Switches to another session by replaying its history (`session/load`).
   * Transactional (issue #17): a failure rolls the client and the driver's
   * snapshot back instead of tearing anything down — the connection stays
   * up unless the transport itself died (the closed watcher reports that).
   * Requires the loadSession capability and an idle turn.
   */
  async loadSession(sessionId: string, cwd: string): Promise<void> {
    const connection = this.connection;
    const generation = this.connectionGeneration;
    if (!connection) {
      console.warn('[panda/acp] loadSession ignored: not connected');
      return;
    }
    if (!this.can('loadSession')) {
      console.warn('[panda/acp] loadSession ignored: agent does not support session/load');
      return;
    }
    if (this.pendingPrompt) {
      console.warn('[panda/acp] loadSession ignored: a turn is still in flight');
      return;
    }
    if (this.sessionSwitch) {
      console.warn('[panda/acp] loadSession ignored: another switch is still in flight');
      return;
    }
    try {
      await this.loadSessionInternal(connection, sessionId, cwd, generation);
      console.info(`[panda/acp] switched to session ${sessionId} (history replayed)`);
    } catch (err) {
      if (generation !== this.connectionGeneration) {
        // The store was already rolled back inside loadSessionInternal (its
        // restores are era-scoped); the failure itself belongs to a dead era.
        console.info('[panda/acp] superseded session/load failed after replacement — failure discarded');
        return;
      }
      // The store was already rolled back inside loadSessionInternal; report
      // loudly but keep the connection — a failed switch is session-scoped,
      // not transport-scoped.
      console.error('[panda/acp] session/load failed — rolled back to the previous session', err);
    }
  }

  /** Removes a session from the agent (`session/delete`, capability-gated). */
  async deleteSession(sessionId: string): Promise<void> {
    const connection = this.connection;
    const generation = this.connectionGeneration;
    if (!connection) {
      console.warn('[panda/acp] deleteSession ignored: not connected');
      return;
    }
    if (!this.can('delete')) {
      console.warn('[panda/acp] deleteSession ignored: agent does not support session/delete');
      return;
    }
    if (this.sessionSwitch) {
      // Deleting the staged target mid-switch would make the pending
      // commit/rollback land on a session that no longer exists.
      console.warn('[panda/acp] deleteSession ignored: a session switch is still in flight');
      return;
    }
    try {
      await connection.agent.request(methods.agent.session.delete, { sessionId });
      if (generation !== this.connectionGeneration) {
        // The delete succeeded on the old service but the era is gone — the
        // sidebar refresh of the new connection reflects reality; folding
        // the removal from here would race the new era's own list.
        console.info('[panda/acp] session/delete completed after the connection was replaced — result discarded');
        return;
      }
      if (this.sessionId === sessionId) {
        console.warn('[panda/acp] deleted the ACTIVE session — local session id cleared');
        this.sessionId = null;
      }
      this.handlers.onSessionDeleted(sessionId);
    } catch (err) {
      if (generation !== this.connectionGeneration) {
        console.info('[panda/acp] superseded deleteSession failed after replacement — failure discarded');
        return;
      }
      console.error('[panda/acp] session/delete failed', err);
      this.reportDisconnect(`删除会话失败: ${describeError(err)}`);
    }
  }

  /**
   * `session/set_mode` (protocol/v1 session-modes). The switch is
   * confirmation-driven: only the resolved RPC updates the document — and it
   * must, because deepagents-acp never emits `current_mode_update` after
   * set_mode. A compliant agent's later notification lands on the same
   * `mode_changed` event idempotently. Failure is logged, never swallowed:
   * the picker stays on the old mode, which is the honest state.
   */
  async setMode(modeId: string): Promise<void> {
    const connection = this.connection;
    const sessionId = this.sessionId;
    if (!connection || !sessionId) {
      console.warn('[panda/acp] set_mode ignored: not connected');
      return;
    }
    const generation = this.connectionGeneration;
    try {
      await connection.agent.request(methods.agent.session.setMode, { sessionId, modeId });
      if (generation !== this.connectionGeneration) {
        // Superseded mid-request: the newer era owns the session state, a
        // late mode_changed would write into its document.
        return;
      }
      this.handlers.onUpdate({ sessionUpdate: 'mode_changed', modeId });
      console.info(`[panda/acp] mode switched: ${modeId}`);
    } catch (err) {
      if (generation !== this.connectionGeneration) {
        // The replacement's close() rejected the request — expected, and the
        // newer era owns the state; not an error of the current connection.
        console.info('[panda/acp] superseded set_mode failed after replacement — failure discarded');
        return;
      }
      console.error(`[panda/acp] set_mode(${modeId}) failed`, err);
    }
  }

  /**
   * `session/set_config_option` (protocol/v1 session-config-options).
   * Confirmation-driven like set_mode: the document only moves when the RPC
   * resolves — the response carries the full updated option list, which is
   * folded as one `config_options_update` (a later agent notification lands
   * on the same event idempotently). Failure is logged, never swallowed:
   * the panel stays on the old values, which is the honest state.
   */
  async setConfigOption(configId: string, value: string | boolean): Promise<void> {
    const connection = this.connection;
    const sessionId = this.sessionId;
    if (!connection || !sessionId) {
      console.warn('[panda/acp] set_config_option ignored: not connected');
      return;
    }
    const generation = this.connectionGeneration;
    // The wire request discriminates boolean writes by an explicit
    // `type: "boolean"` (select writes carry no type).
    const params = typeof value === 'boolean' ? { sessionId, configId, value, type: 'boolean' } : { sessionId, configId, value };
    try {
      const result = await connection.agent.request(methods.agent.session.setConfigOption, params);
      if (generation !== this.connectionGeneration) {
        // Superseded mid-request: the newer era owns the session state, a
        // late config_options_update would write into its document.
        return;
      }
      const options = sessionConfigOptions((result as { configOptions?: unknown }).configOptions, 'session/set_config_option');
      if (options !== null) {
        this.handlers.onUpdate({ sessionUpdate: 'config_options_update', options });
        console.info(`[panda/acp] config option set: ${configId} = ${String(value)}`);
      }
    } catch (err) {
      if (generation !== this.connectionGeneration) {
        console.info('[panda/acp] superseded set_config_option failed after replacement — failure discarded');
        return;
      }
      console.error(`[panda/acp] set_config_option(${configId}) failed`, err);
    }
  }

  /** Sends one ordered set of user content blocks and owns the turn until it resolves. */
  async send(content: AcpContentBlock[]): Promise<void> {
    if (content.length === 0) return;
    if (!this.connection || !this.sessionId) {
      console.warn('[panda/acp] send ignored: not connected');
      return;
    }
    if (this.sessionSwitch) {
      console.warn('[panda/acp] send ignored: a session switch is still in flight');
      return;
    }
    // The execution path consumes the effective-capability decision point
    // (issue #22), never the raw agent declaration; the message names the
    // verdict's own reason, so it stays truthful if image ever gains a host
    // shard or a capability policy.
    const image = this.capability('image');
    if (!image.available && content.some((block) => block.type === 'image')) {
      const cause =
        image.reason === 'unavailable-on-host'
          ? '宿主不支持该能力'
          : image.reason === 'blocked-by-policy'
            ? '策略已禁止该能力'
            : 'agent 未声明 promptCapabilities.image';
      throw new Error(`${cause}，拒绝发送图片`);
    }
    const generation = this.connectionGeneration;
    // The reducer is the only path that opens a user turn — echo locally as
    // optimistic (reconciled against the agent's echo, see pendingOutbound).
    const pendingOutbound: PendingOutbound = { prompt: content, buffered: [], echoWindowClosed: false };
    this.pendingOutbound = pendingOutbound;
    this.handlers.onUpdate({ sessionUpdate: 'user_message', content, optimistic: true });
    this.handlers.onUpdate({ sessionUpdate: 'status_changed', status: 'running' });
    const wirePrompt: ContentBlock[] = content;
    const prompt = this.connection.agent.request(methods.agent.session.prompt, {
      sessionId: this.sessionId,
      prompt: wirePrompt,
    });
    this.pendingPrompt = prompt;
    try {
      const response = await prompt;
      console.info(`[panda/acp] turn complete: ${response.stopReason}`);
      // end_turn is the unremarkable ending; every other stop reason is a
      // user-visible fact about why the turn stopped (refusal, limits,
      // cancellation). A superseded era must not write into the new one.
      //
      // response.usage (UNSTABLE) is NOT mapped: it is a cumulative token
      // tally (total/input/output/thought/cache), not the context-occupancy
      // pair (used/size) the usage_update event and the status bar model.
      // Forcing it in would render a bogus window meter; it needs its own
      // UI surface first.
      if (response.stopReason !== 'end_turn' && generation === this.connectionGeneration) {
        this.handlers.onUpdate({ sessionUpdate: 'turn_notice', stopReason: response.stopReason });
      }
    } catch (err) {
      if (generation !== this.connectionGeneration) {
        // The turn outlived its era: the replacement's close() rejected the
        // request and its cleanup already settled this era's waiters. Sweeping
        // the shared map again could cancel the NEW era's permissions (P1).
        console.info('[panda/acp] superseded session/prompt failed after replacement — failure discarded');
      } else {
        console.error('[panda/acp] session/prompt failed', err);
        // The turn is dead — any permission or elicitation still on screen
        // must be answered.
        this.finishAllPermissions();
        this.finishAllElicitations();
      }
    } finally {
      // Slot ownership, not era equality (issue #19): a replaced era's turn
      // must never touch a newer turn's slots — but when the era merely DIED,
      // cleanup already cleared them and settling the dead turn's status is
      // exactly right (the turn is over, the document goes idle).
      if (this.pendingPrompt === prompt) this.pendingPrompt = null;
      if (this.pendingOutbound === pendingOutbound) {
        // Turn over: render any echo still held un-reconciled, then drop the
        // pending state — with or without protocol confirmation.
        this.settlePendingOutbound();
      }
      if (this.pendingPrompt === null) this.handlers.onUpdate({ sessionUpdate: 'status_changed', status: 'idle' });
    }
  }

  /**
   * Answers one pending `session/request_permission` (keyed by tool call —
   * concurrent requests are answered independently, issue #18).
   */
  resolvePermission(toolCallId: string, kind: PermissionOptionKind): void {
    const entry = this.findPermissionWaiter(toolCallId);
    if (!entry) {
      console.warn(
        `[panda/acp] resolvePermission ignored: no pending request for toolCallId ${toolCallId}`,
      );
      return;
    }
    const option = entry.waiter.wireOptions.find((o) => o.kind === kind);
    if (!option) {
      console.error(
        `[panda/acp] permission option "${kind}" was not offered by the agent for toolCallId ${toolCallId}`,
      );
      this.settlePermission(entry.key, toolCallId, { outcome: { outcome: 'cancelled' } }, { outcome: 'cancelled' });
    } else {
      this.settlePermission(
        entry.key,
        toolCallId,
        { outcome: { outcome: 'selected', optionId: option.optionId } },
        { outcome: 'selected', kind },
      );
    }
  }

  /**
   * Answers one pending `elicitation/create`: form submit (accepted) /
   * refusal (declined) — url-mode decline routes here too. Cancellations
   * without a user decision arrive via settleElicitation instead.
   */
  resolveElicitation(id: string, response: ElicitationResponse): void {
    if (!this.elicitationWaiters.has(id)) {
      console.warn(`[panda/acp] resolveElicitation ignored: no pending request ${id}`);
      return;
    }
    this.settleElicitation(id, response);
  }

  /**
   * Answers one pending url-mode `elicitation/create` with accept — the user
   * consented to opening the link. Per protocol/v1 the RPC ends here (accept
   * means consent, NOT completion); the card then waits for the agent's
   * `elicitation/complete` notification. The window itself is opened by the
   * UI in the click gesture, before this is called — async window.open would
   * be popup-blocked.
   */
  openElicitationUrl(id: string): void {
    const waiter = this.elicitationWaiters.get(id);
    if (!waiter) {
      console.warn(`[panda/acp] openElicitationUrl ignored: no pending request ${id}`);
      return;
    }
    this.elicitationWaiters.delete(id);
    // URL-mode accept carries no content — the interaction completes
    // out-of-band.
    waiter.resolve({ action: 'accept' });
    this.handlers.onUpdate({ sessionUpdate: 'elicitation_url_opened', elicitationId: id });
    this.convergeStatus();
  }

  /** Cancels the in-flight turn: `session/cancel` + cancelled permission outcomes. */
  cancel(): void {
    if (!this.connection || !this.sessionId) return;
    if (!this.pendingPrompt) {
      console.warn('[panda/acp] cancel ignored: no prompt turn in flight');
      return;
    }
    this.connection.agent
      .notify(methods.agent.session.cancel, { sessionId: this.sessionId })
      .catch((err) => console.error('[panda/acp] session/cancel failed', err));
    // Spec: the client MUST answer pending permission requests with cancelled.
    this.finishAllPermissions();
    this.finishAllElicitations();
  }

  /**
   * Cleanly closes the connection; safe to call repeatedly. When the agent
   * advertised `session/close` and a session lives, the close request goes
   * out before the wire drops (bounded — an unresponsive agent must not
   * hang the disconnect), so the agent can release its session-side state.
   */
  disconnect(): void {
    void this.disconnectAsync();
  }

  private async disconnectAsync(): Promise<void> {
    if (this.disconnectReported) return;
    const connection = this.connection;
    const sessionId = this.sessionId;
    const generation = this.connectionGeneration;
    if (connection && sessionId && this.agentSupportsClose) {
      try {
        await Promise.race([
          connection.agent.request(methods.agent.session.close, { sessionId }),
          new Promise<void>((resolve) => setTimeout(resolve, 1500)),
        ]);
      } catch (err) {
        console.warn('[panda/acp] session/close failed (disconnecting anyway)', err);
      }
      // A reconnect while the close was in flight superseded this era — the
      // newer connection owns the state now, never report on its behalf.
      if (this.disconnectReported || generation !== this.connectionGeneration) return;
    }
    this.reportDisconnect(null);
  }

  // -- internals ------------------------------------------------------------

  /**
   * One capability's effective verdict (issue #22): every capability
   * decision in this client — protocol method choice included — goes
   * through the single decision point, never the raw declaration.
   */
  private capability(key: CapabilityKey): EffectiveCapability {
    return effectiveCapability(key, this.capabilities, PANDA_HOST_CAPABILITIES);
  }

  private can(key: CapabilityKey): boolean {
    return this.capability(key).available;
  }

  private async establishSession(connection: ClientConnection, cwd: string, generation: number): Promise<void> {
    const session = await connection.agent.request(methods.agent.session.new, {
      cwd,
      mcpServers: [],
    });
    if (generation !== this.connectionGeneration) {
      // Superseded mid-request (issue #19): the created session stays on the
      // agent (nothing to adopt here); the newer era establishes its own.
      console.warn('[panda/acp] session/new completed after the connection was replaced — result discarded');
      return;
    }
    this.sessionId = session.sessionId;
    this.handlers.onSessionId(session.sessionId, cwd);
    this.handlers.onSessionModes(toSessionModeState(session.modes));
    this.handlers.onSessionConfigOptions(sessionConfigOptions(session.configOptions, 'session/new'));
  }

  /**
   * `session/load` as a transaction (issue #17): stage the target (the
   * driver snapshots the pre-state and routes writes to the target's
   * document), reset the replay area, then commit on success or roll back
   * both this client's session routing and the driver's snapshot on failure.
   * Must set this.sessionId BEFORE the request so replay notifications pass
   * the session filter. If the connection era is superseded while the load
   * is in flight (issue #19), the success path rolls back instead of
   * committing — the newer era owns the settled pointers — and the failure
   * path still rolls back (its restores are era-scoped and land before the
   * newer era writes its own state; skipping them would strand `switching`).
   */
  private async loadSessionInternal(
    connection: ClientConnection,
    sessionId: string,
    cwd: string,
    generation: number,
  ): Promise<void> {
    const prevSessionId = this.sessionId;
    this.sessionSwitch = true;
    try {
      // The whole transaction lives inside the try: if a handler ever throws
      // synchronously, the catch must still roll back and the finally must
      // still release the in-flight flag — otherwise the client locks up.
      this.sessionId = sessionId;
      this.handlers.onSessionSwitchStage(sessionId, cwd, generation);
      this.handlers.onReplayStart();
      const loaded = await connection.agent.request(methods.agent.session.load, {
        sessionId,
        cwd,
        mcpServers: [],
      });
      if (generation !== this.connectionGeneration) {
        console.warn(
          `[panda/acp] session/load for ${sessionId} completed after the connection was replaced — rolled back`,
        );
        // No this.sessionId restore here: cleanup already nulled it and the
        // newer era owns the field (P1-1) — writing prevSessionId back would
        // re-route a dead era onto the new connection.
        this.handlers.onSessionSwitchRollback('连接已被更新的连接替换', generation);
        return;
      }
      // The load's modes land before commit: the staged document is the one
      // the UI will adopt, and onReplayStart already reset its modes to null.
      this.handlers.onSessionModes(toSessionModeState(loaded.modes));
      this.handlers.onSessionConfigOptions(sessionConfigOptions(loaded.configOptions, 'session/load'));
      this.handlers.onSessionSwitchCommit(generation);
    } catch (err) {
      if (generation !== this.connectionGeneration) {
        // The replacement's close() rejected the request — expected. Still
        // roll the staged switch back (its snapshot restore is era-scoped and
        // the marker clear prevents a busy lock), but never touch
        // this.sessionId: the newer era owns it (P1-1).
        console.info(
          '[panda/acp] superseded session/load failed after replacement — staged switch rolled back, routing untouched',
        );
        this.handlers.onSessionSwitchRollback(describeError(err), generation);
        throw err;
      }
      this.sessionId = prevSessionId;
      this.handlers.onSessionSwitchRollback(describeError(err), generation);
      throw err;
    } finally {
      this.sessionSwitch = false;
    }
  }

  private async fetchSessionList(connection: ClientConnection, generation: number): Promise<void> {
    try {
      const entries: SessionSummary[] = [];
      let cursor: string | null = null;
      do {
        const result: ListSessionsResponse = await connection.agent.request(
          methods.agent.session.list,
          { cursor },
        );
        // Defensive: a misbehaving service must not poison the session
        // list — drop entries without a sessionId, loudly.
        const valid = result.sessions.filter((info: ListSessionsResponse['sessions'][number]) => {
          if (typeof info.sessionId === 'string' && info.sessionId.length > 0) return true;
          console.warn(`[panda/acp] session/list entry without sessionId dropped: ${JSON.stringify(info)}`);
          return false;
        });
        entries.push(
          ...valid.map((info: ListSessionsResponse['sessions'][number]) => ({
            sessionId: info.sessionId,
            cwd: info.cwd,
            title: info.title ?? null,
            updatedAt: info.updatedAt ?? null,
          })),
        );
        cursor = result.nextCursor ?? null;
      } while (cursor);
      if (generation !== this.connectionGeneration) {
        console.warn('[panda/acp] session/list completed after the connection was replaced — result discarded');
        return;
      }
      this.handlers.onSessions(entries);
    } catch (err) {
      // Non-fatal: the list is a sidebar convenience, the session still works.
      console.error('[panda/acp] session/list failed', err);
    }
  }

  private handleUpdate(params: SessionNotification): void {
    // Before our own session exists, pass updates through (session/load-style
    // replay arrives before session/new resolves); once it does, foreign
    // sessions are dropped loudly rather than rendered into this stream.
    if (this.sessionId !== null && params.sessionId !== this.sessionId) {
      console.warn(
        `[panda/acp] session/update for session ${params.sessionId} ` +
          `(expected ${this.sessionId}) — dropped`,
      );
      return;
    }
    if (params.update.sessionUpdate === 'session_info_update') {
      // Sidebar bookkeeping; the notification is ALSO recorded at session
      // level via the session_state event below (raw preservation).
      this.handlers.onSessionInfo(params.sessionId, {
        title: params.update.title,
        updatedAt: params.update.updatedAt,
      });
    }
    if (this.reconcileUserEcho(params)) return;
    for (const mapped of toAcpUpdates(params)) {
      this.handlers.onUpdate(mapped);
    }
  }

  /**
   * Echo reconciliation gate (issue #15). Returns true when the notification
   * was consumed (held in the echo buffer, or folded into a confirmation).
   * Any non-echo update while a partial echo is buffered closes the echo
   * window: the partial echo is flushed as real events before it.
   */
  private reconcileUserEcho(params: SessionNotification): boolean {
    const pending = this.pendingOutbound;
    if (!pending || pending.echoWindowClosed) return false;
    const update = params.update;
    if (update.sessionUpdate !== 'user_message_chunk') {
      if (pending.buffered.length > 0) {
        console.info('[panda/acp] echo window closed by non-echo update — flushing partial echo');
        this.flushBufferedEcho();
      }
      return false;
    }
    const incomingId = update.messageId ?? undefined;
    if (pending.protocolMessageId && incomingId && pending.protocolMessageId !== incomingId) {
      // A second protocol message started echoing — the buffered one belongs
      // elsewhere; render the buffer and let this chunk through as-is.
      console.info(
        `[panda/acp] echo messageId changed (${pending.protocolMessageId} -> ${incomingId}) — flushing`,
      );
      this.flushBufferedEcho();
      return false;
    }
    pending.protocolMessageId ??= incomingId;
    pending.buffered.push(params);
    const relation = echoRelation(
      pending.prompt,
      pending.buffered.map((n) => (n.update as { content: ContentBlock }).content),
    );
    if (relation === 'equal') {
      console.info(
        `[panda/acp] echo matched outbound message${pending.protocolMessageId ? ` (messageId ${pending.protocolMessageId})` : ''}`,
      );
      this.handlers.onUpdate({
        sessionUpdate: 'user_message_confirmed',
        protocolMessageId: pending.protocolMessageId,
        notifications: pending.buffered,
      });
      pending.buffered = [];
      pending.echoWindowClosed = true;
      return true;
    }
    if (relation === 'different') {
      // The agent echoed something else: keep the optimistic block untouched
      // and render the protocol version as its own message. Note a `prefix`
      // that never completes is also flushed here or at turn end — an
      // incomplete echo cannot be merged into the optimistic block because
      // it may still diverge later (react-acp semantics, doc §4.7).
      console.info('[panda/acp] echo diverged from outbound message — rendering protocol version');
      this.flushBufferedEcho();
    }
    return true; // equal handled above; prefix keeps buffering, different flushed
  }

  /** Renders the held echo notifications as real events and closes the echo window. */
  private flushBufferedEcho(): void {
    const pending = this.pendingOutbound;
    if (!pending || pending.buffered.length === 0) return;
    for (const notification of pending.buffered) {
      for (const mapped of toAcpUpdates(notification)) {
        this.handlers.onUpdate(mapped);
      }
    }
    pending.buffered = [];
    pending.echoWindowClosed = true;
  }

  /** Turn settled: flush anything still held and drop the reconciliation state. */
  private settlePendingOutbound(): void {
    this.flushBufferedEcho();
    this.pendingOutbound = null;
  }

  /**
   * One `session/request_permission`: records it in the document (the
   * reducer plants a placeholder tool when the tool_call has not arrived
   * yet) and hangs independently — a second request for a *different* tool
   * never cancels this one (issue #18). Re-asking for the same toolCallId
   * supersedes the stale waiter (cancelled) — the RPC would otherwise
   * leak. The request's own AbortSignal (aborted when the agent sends
   * `$/cancel_request`) settles the waiter as cancelled so the card never
   * outlives the agent's interest in it.
   */
  private handlePermissionRequest(
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    // Foreign sessions share handleUpdate's loud-drop policy, but an RPC
    // must be answered: cancelled, and never folded into this stream.
    if (this.sessionId !== null && params.sessionId !== this.sessionId) {
      console.warn(
        `[panda/acp] session/request_permission for session ${params.sessionId} ` +
          `(expected ${this.sessionId}) — answered cancelled`,
      );
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    const key = `${params.sessionId}:${params.toolCall.toolCallId}`;
    const stale = this.permissionWaiters.get(key);
    if (stale) {
      console.warn(
        `[panda/acp] duplicate session/request_permission for ${key} — superseding the stale waiter`,
      );
      this.settlePermission(key, params.toolCall.toolCallId, { outcome: { outcome: 'cancelled' } }, { outcome: 'cancelled' });
    }
    // Host policy consult (issue #22): BEFORE the request hangs for the
    // user. A deny settles here — the card still lands in the document
    // (traceable, explicitly marked 非用户决定) but no waiter registers and
    // the turn never enters requires_action: nothing waits on the user.
    if (this.policy(params) === 'deny') {
      const { wire, record } = denyResolution(params.options);
      console.info(
        `[panda/acp] permission ${key} denied by host policy — answered ${record.kind ?? 'cancelled'}`,
      );
      this.handlers.onUpdate({
        sessionUpdate: 'permission_requested',
        request: toPermissionRequest(params),
      });
      this.handlers.onUpdate({
        sessionUpdate: 'permission_resolved',
        toolCallId: params.toolCall.toolCallId,
        response: record,
      });
      return Promise.resolve(wire);
    }
    this.handlers.onUpdate({
      sessionUpdate: 'permission_requested',
      request: toPermissionRequest(params),
    });
    return new Promise((resolve) => {
      const waiter: PendingPermission = { wireOptions: params.options, resolve };
      this.permissionWaiters.set(key, waiter);
      const settleAborted = () => {
        // Identity check: a superseding waiter under the same key owns the
        // slot now — the old request's signal must not steal it back.
        if (this.permissionWaiters.get(key) !== waiter) return;
        console.warn(
          `[panda/acp] session/request_permission for ${key} aborted by the agent — settling as cancelled`,
        );
        this.settlePermission(key, params.toolCall.toolCallId, { outcome: { outcome: 'cancelled' } }, { outcome: 'cancelled' });
      };
      signal.addEventListener('abort', settleAborted);
      if (signal.aborted) settleAborted();
      else this.convergeStatus();
    });
  }

  /**
   * Finds the waiter for a toolCallId — exact session key first, then a
   * suffix scan. The fallback exists because the UI answers by toolCallId
   * alone while `this.sessionId` can lag the waiter's session (a failed
   * switch rolls it back, deleteSession nulls it); crossing sessions is
   * announced so a mis-routed answer stays traceable.
   */
  private findPermissionWaiter(
    toolCallId: string,
  ): { key: string; waiter: PendingPermission } | null {
    if (this.sessionId !== null) {
      const exactKey = `${this.sessionId}:${toolCallId}`;
      const exact = this.permissionWaiters.get(exactKey);
      if (exact) return { key: exactKey, waiter: exact };
    }
    for (const [key, waiter] of this.permissionWaiters) {
      if (key.endsWith(`:${toolCallId}`)) {
        console.warn(
          `[panda/acp] no pending permission for ${this.sessionId ?? 'unrouted'}:${toolCallId} ` +
            `— answering ${key} by toolCallId suffix`,
        );
        return { key, waiter };
      }
    }
    return null;
  }

  /**
   * Settles one permission: resolves the wire RPC, folds the outcome into
   * the document, and converges the turn status (still requires_action
   * while other permissions remain pending).
   */
  private settlePermission(
    key: string,
    toolCallId: string,
    wireOutcome: RequestPermissionResponse,
    uiResponse: PermissionResponse,
  ): void {
    const waiter = this.permissionWaiters.get(key);
    if (!waiter) return;
    this.permissionWaiters.delete(key);
    waiter.resolve(wireOutcome);
    this.handlers.onUpdate({
      sessionUpdate: 'permission_resolved',
      toolCallId,
      response: uiResponse,
    });
    this.convergeStatus();
  }

  /**
   * `elicitation/create` (form + url modes): folds the request into the
   * document as a card and hangs the RPC until the user answers. Mode- and
   * session-gated like permissions — an unsupported mode is declined (never
   * hung), a foreign/request-scoped elicitation is cancelled loudly.
   */
  private handleElicitationCreate(
    params: CreateElicitationRequest,
    signal: AbortSignal,
  ): Promise<CreateElicitationResponse> {
    if (params.mode !== 'form' && params.mode !== 'url') {
      // The capability negotiation advertises form+url; anything else is a
      // spec violation — decline so the agent can degrade, never hang.
      console.warn(`[panda/acp] elicitation/create with unsupported mode "${String(params.mode)}" — declined`);
      return Promise.resolve({ action: 'decline' });
    }
    // The scope union: session-scoped carries sessionId, request-scoped
    // (pre-session) does not. A request-scoped elicitation while no session
    // lives is the auth phase (v1: OAuth url / API-key form) — it renders on
    // the connection's auth card instead of a session document.
    const scopedSessionId =
      'sessionId' in params && typeof params.sessionId === 'string' ? params.sessionId : null;
    const authScoped = scopedSessionId === null && this.sessionId === null;
    if (!authScoped && (this.sessionId === null || scopedSessionId !== this.sessionId)) {
      const scope = scopedSessionId ?? 'request-scoped (pre-session)';
      console.warn(
        `[panda/acp] elicitation/create for ${scope} (expected session ${this.sessionId ?? 'none'}) — answered cancel`,
      );
      return Promise.resolve({ action: 'cancel' });
    }
    // Url ids come from the wire (opaque, unique per connection — the
    // complete notification matches on them); form ids are minted locally.
    const request =
      params.mode === 'url'
        ? toElicitationUrlRequest(params)
        : toElicitationFormRequest(`elicit-${++this.elicitationSeq}`, params);
    if (this.elicitationWaiters.has(request.id)) {
      // Double-flight on one id would strand one RPC with no card — decline
      // the repeat loudly; the reducer separately guards settled records.
      console.warn(`[panda/acp] elicitation/create reuses pending id ${request.id} — declined`);
      return Promise.resolve({ action: 'decline' });
    }
    if (authScoped) this.handlers.onAuthElicitation(request);
    else this.handlers.onUpdate({ sessionUpdate: 'elicitation_requested', request });
    return new Promise((resolve) => {
      const waiter: PendingElicitation = { scope: authScoped ? 'auth' : 'session', resolve };
      this.elicitationWaiters.set(request.id, waiter);
      const settleAborted = () => {
        if (this.elicitationWaiters.get(request.id) !== waiter) return;
        console.warn(`[panda/acp] elicitation ${request.id} aborted by the agent — settling as cancelled`);
        this.settleElicitation(request.id, { outcome: 'cancelled' });
      };
      signal.addEventListener('abort', settleAborted);
      // Auth-phase elicitations have no document to mark requires_action —
      // the connection is already in auth_required state.
      if (signal.aborted) settleAborted();
      else if (!authScoped) this.convergeStatus();
    });
  }

  private settleElicitation(id: string, response: ElicitationResponse): void {
    const waiter = this.elicitationWaiters.get(id);
    if (!waiter) return;
    this.elicitationWaiters.delete(id);
    if (waiter.scope === 'auth') {
      // Auth-phase cards live on the connection, not a document — clear the
      // challenge card; no document status to re-derive.
      this.handlers.onAuthElicitation(null);
      waiter.resolve(
        response.outcome === 'accepted'
          ? { action: 'accept', content: response.content }
          : response.outcome === 'declined'
            ? { action: 'decline' }
            : { action: 'cancel' },
      );
      return;
    }
    this.handlers.onUpdate({ sessionUpdate: 'elicitation_resolved', elicitationId: id, response });
    waiter.resolve(
      response.outcome === 'accepted'
        ? { action: 'accept', content: response.content }
        : response.outcome === 'declined'
          ? { action: 'decline' }
          : { action: 'cancel' },
    );
    this.convergeStatus();
  }

  /**
   * Converges the turn status after waiter state changed (#55): any pending
   * permission/elicitation holds the turn at requires_action, else the
   * in-flight prompt decides. Emitted as a status_changed event — the
   * document's status is a fact in the event stream, never a side channel.
   */
  private convergeStatus(): void {
    this.handlers.onUpdate({
      sessionUpdate: 'status_changed',
      status:
        this.elicitationWaiters.size > 0 || this.permissionWaiters.size > 0
          ? 'requires_action'
          : this.pendingPrompt
            ? 'running'
            : 'idle',
    });
  }

  /** Cancels every pending elicitation (turn cancel, dead turn, disconnect). */
  private finishAllElicitations(): void {
    for (const id of [...this.elicitationWaiters.keys()]) {
      this.settleElicitation(id, { outcome: 'cancelled' });
    }
  }

  /**
   * `elicitation/complete` (url mode): the agent reports the out-of-band
   * interaction finished. The reducer ignores unknown/finished ids (spec
   * requirement); a still-pending waiter means the user never clicked open
   * yet the flow finished anyway — answer accept, the interaction did happen.
   * Opened cards need no waiter work: their RPC already answered accept, and
   * they live on past turn cancels (the out-of-band flow outruns the turn).
   */
  private handleElicitationComplete(params: CompleteElicitationNotification): void {
    const id = params.elicitationId;
    const waiter = this.elicitationWaiters.get(id);
    if (waiter) {
      console.warn(`[panda/acp] elicitation/complete for ${id} that was never opened — answering accept`);
      this.elicitationWaiters.delete(id);
      waiter.resolve({ action: 'accept' });
      this.convergeStatus();
    }
    this.handlers.onUpdate({ sessionUpdate: 'elicitation_url_completed', elicitationId: id });
  }

  /**
   * Settles every pending permission as cancelled (disconnect / turn
   * cancel). Reuses settlePermission so every card folds a
   * permission_resolved event and the status converges exactly like a user
   * answer — with no prompt left, the last settle lands on idle.
   */
  private finishAllPermissions(): void {
    for (const key of [...this.permissionWaiters.keys()]) {
      const toolCallId = key.slice(key.indexOf(':') + 1);
      this.settlePermission(key, toolCallId, { outcome: { outcome: 'cancelled' } }, { outcome: 'cancelled' });
    }
  }

  /** Idempotent: cleans up state and reports the disconnect exactly once. */
  private reportDisconnect(reason: string | null): void {
    if (this.disconnectReported) return;
    this.disconnectReported = true;
    this.cleanupConnection();
    this.handlers.onDisconnected(reason);
  }

  /** Closes the socket and clears session state without reporting anything. */
  private cleanupConnection(): void {
    // The era is over: every in-flight async flow of the old connection is
    // now superseded (issue #19).
    this.connectionGeneration++;
    // Clear the turn before settling waiters: with no prompt left, their
    // status convergence lands on idle instead of a phantom running.
    this.pendingPrompt = null;
    // The dead era's echo state must not leak into the next connection: its
    // buffered chunks belong to a superseded transcript (issue #19).
    this.pendingOutbound = null;
    this.finishAllPermissions();
    this.finishAllElicitations();
    this.connection?.close();
    this.connection = null;
    // Explicit transport teardown (issue #20): the SDK's close usually
    // already killed the wire — this is the guarantee, not the hope.
    this.transport?.disconnect();
    this.transport = null;
    this.sessionId = null;
    this.sessionSwitch = false;
  }
}
