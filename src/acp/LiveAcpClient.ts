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
  PermissionRequest,
  SessionStatus,
} from '../protocol/types';
import {
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
  onPermission(request: PermissionRequest | null): void;
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
};

type PendingPermission = {
  wireOptions: RequestPermissionRequest['options'];
  resolve: (response: RequestPermissionResponse) => void;
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
  private pendingPermission: PendingPermission | null = null;
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
    try {
      await this.establishSession(connection, cwd);
    } catch (err) {
      console.error('[panda/acp] session/new failed', err);
      this.reportDisconnect(`新建会话失败: ${describeError(err)}`);
    }
  }

  /**
   * Switches to another session by replaying its history (`session/load`).
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
    try {
      await this.loadSessionInternal(connection, sessionId, cwd);
      console.info(`[panda/acp] switched to session ${sessionId} (history replayed)`);
    } catch (err) {
      console.error('[panda/acp] session/load failed', err);
      this.reportDisconnect(`切换会话失败: ${describeError(err)}`);
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
    if (!this.capabilities.image && content.some((block) => block.type === 'image')) {
      throw new Error('agent 未声明 promptCapabilities.image，拒绝发送图片');
    }
    // The reducer is the only path that opens a user turn — echo locally.
    this.handlers.onUpdate({ sessionUpdate: 'user_message', content });
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
      this.finishPermission({ outcome: { outcome: 'cancelled' } });
    } finally {
      this.pendingPrompt = null;
      this.handlers.onStatus('idle');
    }
  }

  /** Answers the pending `session/request_permission` with the chosen option. */
  resolvePermission(kind: PermissionOptionKind): void {
    const pending = this.pendingPermission;
    if (!pending) {
      console.warn('[panda/acp] resolvePermission ignored: no permission request pending');
      return;
    }
    const option = pending.wireOptions.find((o) => o.kind === kind);
    if (!option) {
      console.error(`[panda/acp] permission option "${kind}" was not offered by the agent`);
      this.finishPermission({ outcome: { outcome: 'cancelled' } });
    } else {
      this.finishPermission({ outcome: { outcome: 'selected', optionId: option.optionId } });
    }
    // After the answer the turn either continues or has already ended.
    this.handlers.onStatus(this.pendingPrompt ? 'running' : 'idle');
  }

  /** Cancels the in-flight turn: `session/cancel` + cancelled permission outcome. */
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
    this.finishPermission({ outcome: { outcome: 'cancelled' } });
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
   * `session/load`: reset the document first (via the handler), then route the
   * replay into the freshly-adopted session. Must set this.sessionId BEFORE
   * the request so replay notifications pass the session filter.
   */
  private async loadSessionInternal(
    connection: ClientConnection,
    sessionId: string,
    cwd: string,
  ): Promise<void> {
    this.handlers.onReplayStart();
    this.sessionId = sessionId;
    this.handlers.onSessionId(sessionId, cwd);
    await connection.agent.request(methods.agent.session.load, { sessionId, cwd, mcpServers: [] });
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
    for (const mapped of toAcpUpdates(params)) {
      this.handlers.onUpdate(mapped);
    }
  }

  private handlePermissionRequest(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    if (this.pendingPermission) {
      console.error(
        '[panda/acp] overlapping session/request_permission — answering the older one with cancelled',
      );
      this.finishPermission({ outcome: { outcome: 'cancelled' } });
    }
    return new Promise((resolve) => {
      this.pendingPermission = { wireOptions: params.options, resolve };
      this.handlers.onStatus('requires_action');
      this.handlers.onPermission(toPermissionRequest(params));
    });
  }

  private finishPermission(outcome: RequestPermissionResponse): void {
    const pending = this.pendingPermission;
    if (!pending) return;
    this.pendingPermission = null;
    pending.resolve(outcome);
    this.handlers.onPermission(null);
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
    this.finishPermission({ outcome: { outcome: 'cancelled' } });
    this.connection?.close();
    this.connection = null;
    this.sessionId = null;
    this.pendingPrompt = null;
  }
}
