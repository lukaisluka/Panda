import {
  PROTOCOL_VERSION,
  client,
  methods,
  type AgentCapabilities,
  type ClientConnection,
  type ContentBlock,
  type InitializeResponse,
  type ListSessionsResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type Stream,
} from '@agentclientprotocol/sdk';
import type {
  AcpContentBlock,
  AcpSessionUpdate,
  PermissionOptionKind,
  PermissionResponse,
  SessionStatus,
} from '../protocol/types';
import {
  echoRelation,
  parseSessionNotification,
  removeSdkStrictSessionUpdateRouter,
  toAcpUpdates,
  toPermissionRequest,
} from './wire';

/**
 * Live ACP client (Phase 1+2): speaks v1 ACP over an injected stream to an
 * already-running ACP service — Panda never spawns or manages the agent
 * process, it only consumes the protocol.
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

/** Capability gates as advertised by the agent at initialize (v1). */
export type AgentCaps = {
  image: boolean;
  loadSession: boolean;
  list: boolean;
  resume: boolean;
  delete: boolean;
};

export type SessionSummary = {
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: string | null;
};

export type LiveClientHandlers = {
  onUpdate(update: AcpSessionUpdate): void;
  onStatus(status: SessionStatus): void;
  onConnected(info: { agentName: string; protocolVersion: number }): void;
  onSessionId(sessionId: string, cwd: string): void;
  /** null reason = clean disconnect; a string = failure shown to the user. */
  onDisconnected(reason: string | null): void;
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

type PendingPermission = {
  wireOptions: RequestPermissionRequest['options'];
  resolve: (response: RequestPermissionResponse) => void;
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

export class LiveAcpClient {
  private readonly handlers: LiveClientHandlers;
  private connection: ClientConnection | null = null;
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

  constructor(handlers: LiveClientHandlers) {
    this.handlers = handlers;
  }

  /**
   * Connects and establishes a session: initialize (+ capabilities, session
   * list) → resume / load / new. Failures are reported through
   * `onDisconnected`, never thrown — the connection state in the store is the
   * source of truth for the UI.
   */
  async connect(stream: Stream, cwd: string, resume?: { sessionId: string }): Promise<void> {
    // Replace any prior connection silently — its close handler is muted by
    // the connection-identity check below, and its era by the generation
    // counter (issue #19).
    this.cleanupConnection();
    this.disconnectReported = false;
    const generation = this.connectionGeneration;
    const app = client({ name: 'panda' });
    // The SDK's built-in session/update router strictly zod-parses before any
    // handler runs and drops schema-invalid notifications (unknown kinds) —
    // remove it so the lenient parser below is the only parse seam.
    removeSdkStrictSessionUpdateRouter(app);
    const connection = app
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
      .onRequest(methods.client.session.requestPermission, (ctx) => {
        if (generation !== this.connectionGeneration) {
          console.warn(
            '[panda/acp] session/request_permission from a superseded connection — answered cancelled',
          );
          return Promise.resolve({ outcome: { outcome: 'cancelled' } });
        }
        return this.handlePermissionRequest(ctx.params, ctx.signal);
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

    /** True while this connect's era is still the current one. */
    const isCurrent = () => generation === this.connectionGeneration;
    /** A superseded connect's result: close quietly, never report — the newer era owns the state. */
    const discardSuperseded = (where: string) => {
      console.info(`[panda/acp] connect superseded by a newer connection (${where}) — discarded`);
      connection.close();
    };

    try {
      const init: InitializeResponse = await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
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
      this.handlers.onCapabilities(this.capabilities);
      if (this.capabilities.list) await this.fetchSessionList(connection, generation);
      if (!isCurrent()) {
        discardSuperseded('session list');
        return;
      }

      if (resume?.sessionId) {
        if (this.capabilities.resume) {
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
        } else if (this.capabilities.loadSession) {
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
      console.error('[panda/acp] session/new failed', err);
      this.reportDisconnect(`新建会话失败: ${describeError(err)}`);
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
    if (!this.capabilities.loadSession) {
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
    if (!this.capabilities.delete) {
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
    if (!this.capabilities.image && content.some((block) => block.type === 'image')) {
      throw new Error('agent 未声明 promptCapabilities.image，拒绝发送图片');
    }
    const generation = this.connectionGeneration;
    // The reducer is the only path that opens a user turn — echo locally as
    // optimistic (reconciled against the agent's echo, see pendingOutbound).
    const pendingOutbound: PendingOutbound = { prompt: content, buffered: [], echoWindowClosed: false };
    this.pendingOutbound = pendingOutbound;
    this.handlers.onUpdate({ sessionUpdate: 'user_message', content, optimistic: true });
    this.handlers.onStatus('running');
    const wirePrompt: ContentBlock[] = content;
    const prompt = this.connection.agent.request(methods.agent.session.prompt, {
      sessionId: this.sessionId,
      prompt: wirePrompt,
    });
    this.pendingPrompt = prompt;
    try {
      const response = await prompt;
      console.info(`[panda/acp] turn complete: ${response.stopReason}`);
    } catch (err) {
      if (generation !== this.connectionGeneration) {
        // The turn outlived its era: the replacement's close() rejected the
        // request and its cleanup already settled this era's waiters. Sweeping
        // the shared map again could cancel the NEW era's permissions (P1).
        console.info('[panda/acp] superseded session/prompt failed after replacement — failure discarded');
      } else {
        console.error('[panda/acp] session/prompt failed', err);
        // The turn is dead — any permission still on screen must be answered.
        this.finishAllPermissions();
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
      if (this.pendingPrompt === null) this.handlers.onStatus('idle');
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
  }

  /** Cleanly closes the connection; safe to call repeatedly. */
  disconnect(): void {
    this.reportDisconnect(null);
  }

  // -- internals ------------------------------------------------------------

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
      await connection.agent.request(methods.agent.session.load, { sessionId, cwd, mcpServers: [] });
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
      else this.handlers.onStatus('requires_action');
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
    this.handlers.onStatus(
      this.permissionWaiters.size > 0
        ? 'requires_action'
        : this.pendingPrompt
          ? 'running'
          : 'idle',
    );
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
    this.connection?.close();
    this.connection = null;
    this.sessionId = null;
    this.sessionSwitch = false;
  }
}
