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
   */
  onSessionSwitchStage(sessionId: string, cwd: string): void;
  /** The switch's session/load resolved — the driver commits the staged target. */
  onSessionSwitchCommit(): void;
  /** The switch's session/load failed — the driver rolls back to the snapshot. */
  onSessionSwitchRollback(reason: string): void;
};

type PendingPermission = {
  wireOptions: RequestPermissionRequest['options'];
  resolve: (response: RequestPermissionResponse) => void;
};/**
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
    // the connection-identity check below.
    this.cleanupConnection();
    this.disconnectReported = false;
    const app = client({ name: 'panda' });
    // The SDK's built-in session/update router strictly zod-parses before any
    // handler runs and drops schema-invalid notifications (unknown kinds) —
    // remove it so the lenient parser below is the only parse seam.
    removeSdkStrictSessionUpdateRouter(app);
    const connection = app
      .onNotification(
        methods.client.session.update,
        parseSessionNotification,
        (ctx) => this.handleUpdate(ctx.params),
      )
      .onRequest(methods.client.session.requestPermission, (ctx) =>
        this.handlePermissionRequest(ctx.params),
      )
      .connect(stream);
    this.connection = connection;
    // Only an *unexpected* close reports a disconnect — a replaced or already
    // cleaned-up connection no longer owns `this.connection`.
    connection.closed
      .catch(() => {})
      .then(() => {
        if (this.connection === connection) this.reportDisconnect('与服务器的连接已断开');
      });

    try {
      const init: InitializeResponse = await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: CLIENT_INFO,
      });
      if (init.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(
          `agent 协商了协议 v${init.protocolVersion}，Panda 目前只支持 v${PROTOCOL_VERSION}`,
        );
      }
      const agentName = init.agentInfo?.title ?? init.agentInfo?.name ?? 'unknown agent';

      this.capabilities = readCaps(init.agentCapabilities);
      this.handlers.onCapabilities(this.capabilities);
      if (this.capabilities.list) await this.fetchSessionList(connection);

      if (resume?.sessionId) {
        if (this.capabilities.resume) {
          // Transcript stays as-is: the agent context resumes without replay.
          this.sessionId = resume.sessionId;
          this.handlers.onSessionId(resume.sessionId, cwd);
          await connection.agent.request(methods.agent.session.resume, {
            sessionId: resume.sessionId,
            cwd,
          });
          console.info(`[panda/acp] resumed session ${resume.sessionId} (transcript kept)`);
        } else if (this.capabilities.loadSession) {
          await this.loadSessionInternal(connection, resume.sessionId, cwd);
          console.info(`[panda/acp] reconnected via session/load replay: ${resume.sessionId}`);
        } else {
          console.warn('[panda/acp] agent 不支持会话恢复（resume/loadSession 均未声明）— 已新建会话');
          await this.establishSession(connection, cwd);
        }
      } else {
        await this.establishSession(connection, cwd);
      }

      this.handlers.onConnected({ agentName, protocolVersion: init.protocolVersion });
      console.info(`[panda/acp] connected: ${agentName} (protocol v${init.protocolVersion})`);
    } catch (err) {
      console.error('[panda/acp] connect failed', err);
      this.reportDisconnect(`连接失败: ${describeError(err)}`);
    }
  }

  /** Sends `session/new` on the live connection and adopts the new session. */
  async newSession(cwd: string): Promise<void> {
    const connection = this.connection;
    if (!connection) {
      console.warn('[panda/acp] newSession ignored: not connected');
      return;
    }
    if (this.sessionSwitch) {
      console.warn('[panda/acp] newSession ignored: a session switch is still in flight');
      return;
    }
    try {
      await this.establishSession(connection, cwd);
    } catch (err) {
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
      await this.loadSessionInternal(connection, sessionId, cwd);
      console.info(`[panda/acp] switched to session ${sessionId} (history replayed)`);
    } catch (err) {
      // The store was already rolled back inside loadSessionInternal; report
      // loudly but keep the connection — a failed switch is session-scoped,
      // not transport-scoped (#19 adds generation guards for rapid retries).
      console.error('[panda/acp] session/load failed — rolled back to the previous session', err);
    }
  }

  /** Removes a session from the agent (`session/delete`, capability-gated). */
  async deleteSession(sessionId: string): Promise<void> {
    const connection = this.connection;
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
      if (this.sessionId === sessionId) {
        console.warn('[panda/acp] deleted the ACTIVE session — local session id cleared');
        this.sessionId = null;
      }
      this.handlers.onSessionDeleted(sessionId);
    } catch (err) {
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
    // The reducer is the only path that opens a user turn — echo locally as
    // optimistic (reconciled against the agent's echo, see pendingOutbound).
    this.pendingOutbound = { prompt: content, buffered: [], echoWindowClosed: false };
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
      console.error('[panda/acp] session/prompt failed', err);
      // The turn is dead — any permission still on screen must be answered.
      this.finishAllPermissions();
    } finally {
      this.pendingPrompt = null;
      // Turn over: render any echo still held un-reconciled, then drop the
      // pending state — with or without protocol confirmation.
      this.settlePendingOutbound();
      this.handlers.onStatus('idle');
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

  private async establishSession(connection: ClientConnection, cwd: string): Promise<void> {
    const session = await connection.agent.request(methods.agent.session.new, {
      cwd,
      mcpServers: [],
    });
    this.sessionId = session.sessionId;
    this.handlers.onSessionId(session.sessionId, cwd);
  }

  /**
   * `session/load` as a transaction (issue #17): stage the target (the
   * driver snapshots the pre-state and routes writes to the target's
   * document), reset the replay area, then commit on success or roll back
   * both this client's session routing and the driver's snapshot on failure.
   * Must set this.sessionId BEFORE the request so replay notifications pass
   * the session filter.
   */
  private async loadSessionInternal(
    connection: ClientConnection,
    sessionId: string,
    cwd: string,
  ): Promise<void> {
    const prevSessionId = this.sessionId;
    this.sessionSwitch = true;
    try {
      // The whole transaction lives inside the try: if a handler ever throws
      // synchronously, the catch must still roll back and the finally must
      // still release the in-flight flag — otherwise the client locks up.
      this.sessionId = sessionId;
      this.handlers.onSessionSwitchStage(sessionId, cwd);
      this.handlers.onReplayStart();
      await connection.agent.request(methods.agent.session.load, { sessionId, cwd, mcpServers: [] });
      this.handlers.onSessionSwitchCommit();
    } catch (err) {
      this.sessionId = prevSessionId;
      this.handlers.onSessionSwitchRollback(describeError(err));
      throw err;
    } finally {
      this.sessionSwitch = false;
    }
  }

  private async fetchSessionList(connection: ClientConnection): Promise<void> {
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
   * supersedes the stale waiter (cancelled) — the RPC would otherwise leak.
   */
  private handlePermissionRequest(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
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
      this.permissionWaiters.set(key, { wireOptions: params.options, resolve });
      this.handlers.onStatus('requires_action');
    });
  }

  /** Finds the waiter for a toolCallId — exact session key first, then suffix. */
  private findPermissionWaiter(
    toolCallId: string,
  ): { key: string; waiter: PendingPermission } | null {
    if (this.sessionId !== null) {
      const exact = this.permissionWaiters.get(`${this.sessionId}:${toolCallId}`);
      if (exact) return { key: `${this.sessionId}:${toolCallId}`, waiter: exact };
    }
    for (const [key, waiter] of this.permissionWaiters) {
      if (key.endsWith(`:${toolCallId}`)) return { key, waiter };
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

  /** Settles every pending permission as cancelled (disconnect / turn cancel). */
  private finishAllPermissions(): void {
    for (const [key, waiter] of [...this.permissionWaiters]) {
      const toolCallId = key.slice(key.indexOf(':') + 1);
      waiter.resolve({ outcome: { outcome: 'cancelled' } });
      this.permissionWaiters.delete(key);
      this.handlers.onUpdate({
        sessionUpdate: 'permission_resolved',
        toolCallId,
        response: { outcome: 'cancelled' },
      });
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
    this.finishAllPermissions();
    this.connection?.close();
    this.connection = null;
    this.sessionId = null;
    this.pendingPrompt = null;
    this.sessionSwitch = false;
  }
}
