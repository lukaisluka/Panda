import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  agent,
  methods,
  type AgentConnection,
  type AgentRequestContext,
  type AnyMessage,
  type PromptRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type Stream,
} from '@agentclientprotocol/sdk';
import { LiveAcpClient, type LiveClientHandlers } from './LiveAcpClient';
import type { PermissionDecision } from '../policy';
import { StreamTransport } from './transport/StreamTransport';
import type { AcpTransport } from './transport/AcpTransport';
import {
  connectionStorePort,
  usePanda,
  type ConnectionStorePort,
  type SessionSwitchSnapshot,
} from '../store';
import type { AcpSessionUpdate, SessionStatus } from '../protocol/types';

/**
 * Drives LiveAcpClient against a scripted SDK `agent()` app over an in-memory
 * stream pair — the full JSON-RPC layer of both sides runs for real, only the
 * transport is fake.
 */

type PromptCtx = AgentRequestContext<PromptRequest>;
type PromptHandler = (ctx: PromptCtx) => Promise<{ stopReason: 'end_turn' | 'cancelled' }>;

type Records = {
  updates: AcpSessionUpdate[];
  statuses: SessionStatus[];
  connected: { agentName: string; protocolVersion: number }[];
  sessionIds: string[];
  disconnected: (string | null)[];
  capabilities: { image: boolean; loadSession: boolean; list: boolean; resume: boolean; delete: boolean }[];
  sessions: { sessionId: string; cwd: string; title: string | null; updatedAt: string | null }[][];
  sessionInfos: { sessionId: string; title?: string | null; updatedAt?: string | null }[];
  replays: number[];
  deletedSessions: string[];
  /**
   * Transactional switch records (issue #17), in emission order. `era` is the
   * client's connectionGeneration at transaction start (issue #19) — the
   * driver matches it before consuming a settle.
   */
  switchLog: (
    | { kind: 'stage'; sessionId: string; cwd: string; era: number }
    | { kind: 'commit'; era: number }
    | { kind: 'rollback'; reason: string; era: number }
  )[];
};

type Harness = Records & {
  acpClient: LiveAcpClient;
  agentState: {
    cancelNotifications: { sessionId: string }[];
    permissionResponses: RequestPermissionResponse[];
    resumeRequests: string[];
    deleteRequests: string[];
  };
  serverConnection: AgentConnection;
  /** Simulates the ACP service dying: kills the transport in both directions. */
  killTransport: () => void;
  closeAll: () => void;
};

type FakeAgentOptions = {
  protocolVersion?: number;
  /** Capability gates advertised at initialize. */
  capabilities?: { image?: boolean; loadSession?: boolean; list?: boolean; resume?: boolean; delete?: boolean };
  /** Entries returned by session/list. */
  listSessions?: { sessionId: string; cwd: string; title?: string | null; updatedAt?: string | null }[];
  /** Per-session replay history served by session/load. */
  history?: Record<string, { sessionUpdate: string; [key: string]: unknown }[]>;
  /** Session ids whose session/load request rejects (switch-failure paths). */
  failLoadFor?: string[];
  /** Suspends every session/load until the returned promise resolves. */
  beforeLoad?: () => Promise<void>;
  /** Suspends every session/new until the returned promise resolves (supersede tests). */
  beforeNewSession?: () => Promise<void>;
  /** Reconnect target passed to LiveAcpClient.connect. */
  resume?: { sessionId: string };
  /** Sees every JSON-RPC message the fake agent sends (wire-level assertions). */
  spyAgentOutgoing?: (message: AnyMessage) => void;
  onPrompt?: PromptHandler;
  /** Host policy injected into the client (issue #22); default = always ask. */
  clientPolicy?: (request: RequestPermissionRequest) => PermissionDecision;
};

function streamPair(): { clientStream: Stream; serverStream: Stream } {
  const c2s = new TransformStream<AnyMessage>();
  const s2c = new TransformStream<AnyMessage>();
  return {
    clientStream: { writable: c2s.writable, readable: s2c.readable },
    serverStream: { writable: s2c.writable, readable: c2s.readable },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Transport seam doubles for client-level failure paths (issue #20). */
class FailingTransport implements AcpTransport {
  constructor(private readonly err: Error) {}
  async connect(): Promise<Stream> {
    throw this.err;
  }
  disconnect(): void {}
}

/** Fails only after a gate resolves — superseded-while-opening scenarios. */
class GatedFailingTransport implements AcpTransport {
  readonly disconnect = vi.fn();
  constructor(private readonly gate: Promise<void>, private readonly err: Error) {}
  async connect(): Promise<Stream> {
    await this.gate;
    throw this.err;
  }
}

async function setup(opts: FakeAgentOptions = {}): Promise<Harness> {
  const records: Records = {
    updates: [],
    statuses: [],
    connected: [],
    sessionIds: [],
    disconnected: [],
    capabilities: [],
    sessions: [],
    sessionInfos: [],
    replays: [],
    deletedSessions: [],
    switchLog: [],
  };
  const handlers: LiveClientHandlers = {
    onUpdate: (update) => records.updates.push(update),
    onStatus: (status) => records.statuses.push(status),
    onConnected: (info) => records.connected.push(info),
    onSessionId: (id) => records.sessionIds.push(id),
    onDisconnected: (reason) => records.disconnected.push(reason),
    onCapabilities: (caps) => records.capabilities.push(caps),
    onSessions: (entries) => records.sessions.push(entries),
    onSessionInfo: (sessionId, info) => records.sessionInfos.push({ sessionId, ...info }),
    onReplayStart: () => records.replays.push(records.replays.length + 1),
    onSessionDeleted: (sessionId) => records.deletedSessions.push(sessionId),
    onSessionSwitchStage: (sessionId, cwd, era) => records.switchLog.push({ kind: 'stage', sessionId, cwd, era }),
    onSessionSwitchCommit: (era) => records.switchLog.push({ kind: 'commit', era }),
    onSessionSwitchRollback: (reason, era) => records.switchLog.push({ kind: 'rollback', reason, era }),
  };

  const agentState = {
    cancelNotifications: [] as { sessionId: string }[],
    permissionResponses: [] as RequestPermissionResponse[],
    resumeRequests: [] as string[],
    deleteRequests: [] as string[],
  };

  const caps = opts.capabilities ?? {};
  const sessionCaps = {
    ...(caps.list ? { list: {} } : {}),
    ...(caps.resume ? { resume: {} } : {}),
    ...(caps.delete ? { delete: {} } : {}),
  };

  const { clientStream, serverStream: rawServerStream } = streamPair();
  // Optional wire tap on the agent's outgoing messages (e.g. to learn the
  // JSON-RPC id of a server-initiated request before cancelling it).
  const serverStream = (() => {
    if (!opts.spyAgentOutgoing) return rawServerStream;
    const writer = rawServerStream.writable.getWriter();
    return {
      readable: rawServerStream.readable,
      writable: new WritableStream<AnyMessage>({
        write: (chunk) => {
          opts.spyAgentOutgoing!(chunk);
          return writer.write(chunk);
        },
        abort: (reason) => writer.abort(reason),
      }),
    };
  })();
  const serverConnection: AgentConnection = agent({ name: 'fake-agent' })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: opts.protocolVersion ?? PROTOCOL_VERSION,
      agentInfo: { name: 'fake-agent', title: 'Fake Agent', version: '0.0.0' },
      agentCapabilities: {
        ...(caps.loadSession ? { loadSession: true } : {}),
        ...(caps.image ? { promptCapabilities: { image: true } } : {}),
        ...(Object.keys(sessionCaps).length > 0 ? { sessionCapabilities: sessionCaps } : {}),
      },
    }))
    .onRequest(methods.agent.session.new, async () => {
      await opts.beforeNewSession?.();
      return { sessionId: 's-1' };
    })
    .onRequest(methods.agent.session.list, () => ({
      sessions: opts.listSessions ?? [],
    }))
    .onRequest(methods.agent.session.load, async (ctx) => {
      await opts.beforeLoad?.();
      if (opts.failLoadFor?.includes(ctx.params.sessionId)) {
        throw new Error(`session ${ctx.params.sessionId} 不存在`);
      }
      const history = opts.history?.[ctx.params.sessionId] ?? [];
      for (const update of history) {
        await ctx.client.notify(methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update,
        });
      }
      return {};
    })
    .onRequest(methods.agent.session.resume, (ctx) => {
      agentState.resumeRequests.push(ctx.params.sessionId);
      return {};
    })
    .onRequest(methods.agent.session.delete, (ctx) => {
      agentState.deleteRequests.push(ctx.params.sessionId);
      return {};
    })
    .onNotification(methods.agent.session.cancel, (ctx) => {
      agentState.cancelNotifications.push(ctx.params);
    })
    .onRequest(methods.agent.session.prompt, (ctx) => opts.onPrompt?.(ctx) ?? { stopReason: 'end_turn' })
    .connect(serverStream);

  const acpClient = new LiveAcpClient(
    handlers,
    opts.clientPolicy ? { policy: opts.clientPolicy } : {},
  );
  await acpClient.connect(new StreamTransport(clientStream), '/tmp/project', opts.resume);

  return {
    ...records,
    acpClient,
    agentState,
    serverConnection,
    killTransport: () => {
      serverConnection.close();
      void serverStream.writable.abort(new Error('service died'));
      void serverStream.readable.cancel().catch(() => {});
    },
    closeAll: () => {
      acpClient.disconnect();
      serverConnection.close();
    },
  };
}

/** Agent-side helper: notify one session/update for the prompt's session. */
function notifyUpdate(ctx: PromptCtx, payload: object) {
  return ctx.client.notify(methods.client.session.update, {
    sessionId: ctx.params.sessionId,
    update: payload,
  });
}

/** Permission lifecycle events folded through the document stream (issue #18). */
function permissionEvents(h: Harness) {
  return h.updates.filter(
    (u): u is Extract<typeof u, { sessionUpdate: 'permission_requested' | 'permission_resolved' }> =>
      u.sessionUpdate === 'permission_requested' || u.sessionUpdate === 'permission_resolved',
  );
}

/** Waits until the document stream has seen `n` permission events. */
async function waitForPermissionEvents(h: Harness, n: number) {
  await waitFor(() => permissionEvents(h).length >= n);
}

/** Agent-side helper: ask for permission and record the client's answer. */
function askPermission(ctx: PromptCtx, h: Harness) {
  return ctx.client
    .request(methods.client.session.requestPermission, {
      sessionId: ctx.params.sessionId,
      toolCall: { toolCallId: 'edit-1', title: 'Edit file: src/a.ts', kind: 'edit', status: 'pending' },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    })
    .then((response) => {
      h.agentState.permissionResponses.push(response);
      return response;
    });
}

describe('LiveAcpClient', () => {
  it('advertises the image prompt capability and sends images before text', async () => {
    const prompts: PromptRequest['prompt'][] = [];
    const h = await setup({
      capabilities: { image: true },
      onPrompt: async (ctx) => {
        prompts.push(ctx.params.prompt);
        return { stopReason: 'end_turn' };
      },
    });

    expect(h.capabilities).toEqual([
      { image: true, loadSession: false, list: false, resume: false, delete: false },
    ]);

    const content = [
      { type: 'image' as const, data: 'aGk=', mimeType: 'image/png' },
      { type: 'text' as const, text: 'describe this' },
    ];
    await h.acpClient.send(content);

    expect(prompts).toEqual([content]);
    expect(h.updates[0]).toEqual({ sessionUpdate: 'user_message', content, optimistic: true });
    h.closeAll();
  });

  it('allows a pure-image prompt', async () => {
    const prompts: PromptRequest['prompt'][] = [];
    const h = await setup({
      capabilities: { image: true },
      onPrompt: async (ctx) => {
        prompts.push(ctx.params.prompt);
        return { stopReason: 'end_turn' };
      },
    });

    const image = { type: 'image' as const, data: 'aGk=', mimeType: 'image/png' };
    await h.acpClient.send([image]);

    expect(prompts).toEqual([[image]]);
    h.closeAll();
  });

  it('reports image prompt capability as disabled when the agent omits it', async () => {
    const h = await setup();
    expect(h.capabilities[0]?.image).toBe(false);
    await expect(
      h.acpClient.send([{ type: 'image', data: 'aGk=', mimeType: 'image/png' }]),
    ).rejects.toThrow('agent 未声明 promptCapabilities.image');
    expect(h.updates).toEqual([]);
    h.closeAll();
  });

  it('connects (v1 handshake, agent identity, session) and runs a full turn', async () => {
    const onPrompt: PromptHandler = async (ctx) => {
      await notifyUpdate(ctx, {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm-1',
        content: { type: 'text', text: '你好' },
      });
      await notifyUpdate(ctx, {
        sessionUpdate: 'tool_call',
        toolCallId: 't-1',
        title: 'Read file',
        kind: 'read',
        status: 'pending',
      });
      await notifyUpdate(ctx, {
        sessionUpdate: 'usage_update',
        used: 100,
        size: 1000,
        cost: { amount: 0.1, currency: 'USD' },
      });
      return { stopReason: 'end_turn' };
    };
    const h = await setup({ onPrompt });

    expect(h.connected).toEqual([{ agentName: 'Fake Agent', protocolVersion: PROTOCOL_VERSION }]);
    expect(h.sessionIds).toEqual(['s-1']);
    expect(h.disconnected).toEqual([]);

    await h.acpClient.send([{ type: 'text', text: 'hi' }]);

    // The user's own message is echoed locally, opening the turn.
    expect(h.updates[0]).toEqual({
      sessionUpdate: 'user_message',
      content: [{ type: 'text', text: 'hi' }],
      optimistic: true,
    });
    expect(h.updates).toContainEqual(
      expect.objectContaining({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm-1',
        content: { type: 'text', text: '你好' },
      }),
    );
    expect(h.updates).toContainEqual(
      expect.objectContaining({
        sessionUpdate: 'tool_call',
        toolCallId: 't-1',
        title: 'Read file',
        kind: 'read',
        status: 'pending',
      }),
    );
    expect(h.updates).toContainEqual(
      expect.objectContaining({
        sessionUpdate: 'usage_update',
        used: 100,
        size: 1000,
        cost: { amount: 0.1, currency: 'USD' },
      }),
    );
    // v1 status synthesis: running on send, idle when the prompt resolves.
    expect(h.statuses[0]).toBe('running');
    expect(h.statuses.at(-1)).toBe('idle');
    h.closeAll();
  });

  it('suspends on request_permission and echoes the allow optionId back', async () => {
    const harnessRef: { h?: Harness } = {};
    const onPrompt: PromptHandler = async (ctx) => {
      await askPermission(ctx, harnessRef.h!);
      return { stopReason: 'end_turn' };
    };
    const h = await setup({ onPrompt });
    harnessRef.h = h;

    const turn = h.acpClient.send([{ type: 'text', text: 'edit it' }]);
    await waitForPermissionEvents(h, 1);

    expect(h.statuses).toContain('requires_action');
    expect(permissionEvents(h)).toEqual([
      {
        sessionUpdate: 'permission_requested',
        request: {
          toolCallId: 'edit-1',
          title: 'Edit file: src/a.ts',
          kind: 'edit',
          options: [
            { id: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { id: 'reject-once', name: 'Reject', kind: 'reject_once' },
          ],
        },
      },
    ]);

    h.acpClient.resolvePermission('edit-1', 'allow_once');
    await turn;

    expect(h.agentState.permissionResponses).toEqual([
      { outcome: { outcome: 'selected', optionId: 'allow-once' } },
    ]);
    expect(permissionEvents(h).at(-1)).toEqual({
      sessionUpdate: 'permission_resolved',
      toolCallId: 'edit-1',
      response: { outcome: 'selected', kind: 'allow_once' },
    });
    // answered → turn continues (running) → prompt resolves (idle)
    expect(h.statuses).toEqual(expect.arrayContaining(['requires_action', 'running', 'idle']));
    h.closeAll();
  });

  it('echoes the reject optionId when the user rejects', async () => {
    const harnessRef: { h?: Harness } = {};
    const onPrompt: PromptHandler = async (ctx) => {
      await askPermission(ctx, harnessRef.h!);
      return { stopReason: 'end_turn' };
    };
    const h = await setup({ onPrompt });
    harnessRef.h = h;

    const turn = h.acpClient.send([{ type: 'text', text: 'edit it' }]);
    await waitForPermissionEvents(h, 1);

    h.acpClient.resolvePermission('edit-1', 'reject_once');
    await turn;

    expect(h.agentState.permissionResponses).toEqual([
      { outcome: { outcome: 'selected', optionId: 'reject-once' } },
    ]);
    expect(permissionEvents(h).at(-1)).toEqual({
      sessionUpdate: 'permission_resolved',
      toolCallId: 'edit-1',
      response: { outcome: 'selected', kind: 'reject_once' },
    });
    h.closeAll();
  });

  // -- host policy (issue #22) --------------------------------------------------

  it('policy deny answers reject_once immediately; the card lands and settles as denied-by-policy', async () => {
    const harnessRef: { h?: Harness } = {};
    const onPrompt: PromptHandler = async (ctx) => {
      await askPermission(ctx, harnessRef.h!);
      return { stopReason: 'end_turn' };
    };
    const h = await setup({ onPrompt, clientPolicy: () => 'deny' });
    harnessRef.h = h;

    const turn = h.acpClient.send([{ type: 'text', text: 'edit it' }]);
    await turn;

    // Wire: the agent's reject_once option, answered without the user.
    expect(h.agentState.permissionResponses).toEqual([
      { outcome: { outcome: 'selected', optionId: 'reject-once' } },
    ]);
    // Document: requested then settled — traceable, marked 非用户决定.
    expect(permissionEvents(h)).toEqual([
      {
        sessionUpdate: 'permission_requested',
        request: expect.objectContaining({ toolCallId: 'edit-1' }),
      },
      {
        sessionUpdate: 'permission_resolved',
        toolCallId: 'edit-1',
        response: { outcome: 'denied-by-policy', kind: 'reject_once' },
      },
    ]);
    // Nothing waits on the user: the turn never enters requires_action.
    expect(h.statuses).not.toContain('requires_action');
    h.closeAll();
  });

  it('policy deny with no reject option offered answers cancelled', async () => {
    const harnessRef: { h?: Harness } = {};
    const onPrompt: PromptHandler = async (ctx) => {
      // A hostile/malformed agent: only allow options on offer.
      const response = await ctx.client.request(methods.client.session.requestPermission, {
        sessionId: ctx.params.sessionId,
        toolCall: { toolCallId: 'edit-1', title: 'Edit file: src/a.ts', kind: 'edit', status: 'pending' },
        options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
      });
      harnessRef.h!.agentState.permissionResponses.push(response);
      return { stopReason: 'end_turn' };
    };
    const h = await setup({ onPrompt, clientPolicy: () => 'deny' });
    harnessRef.h = h;

    const turn = h.acpClient.send([{ type: 'text', text: 'edit it' }]);
    await turn;

    expect(h.agentState.permissionResponses).toEqual([{ outcome: { outcome: 'cancelled' } }]);
    expect(permissionEvents(h).at(-1)).toEqual({
      sessionUpdate: 'permission_resolved',
      toolCallId: 'edit-1',
      response: { outcome: 'denied-by-policy', kind: null },
    });
    h.closeAll();
  });

  it('cancel() notifies session/cancel and answers pending permission with cancelled', async () => {
    const harnessRef: { h?: Harness } = {};
    const onPrompt: PromptHandler = async (ctx) => {
      const response = await askPermission(ctx, harnessRef.h!);
      return { stopReason: response.outcome.outcome === 'cancelled' ? 'cancelled' : 'end_turn' };
    };
    const h = await setup({ onPrompt });
    harnessRef.h = h;

    const turn = h.acpClient.send([{ type: 'text', text: 'edit it' }]);
    await waitForPermissionEvents(h, 1);

    h.acpClient.cancel();
    await turn;

    expect(h.agentState.cancelNotifications).toEqual([{ sessionId: 's-1' }]);
    expect(h.agentState.permissionResponses).toEqual([{ outcome: { outcome: 'cancelled' } }]);
    expect(permissionEvents(h).at(-1)).toEqual({
      sessionUpdate: 'permission_resolved',
      toolCallId: 'edit-1',
      response: { outcome: 'cancelled' },
    });
    expect(h.statuses.at(-1)).toBe('idle');
    h.closeAll();
  });

  it('keeps two concurrent permissions independent — each answered separately (issue #18)', async () => {
    const harnessRef: { h?: Harness } = {};
    const onPrompt: PromptHandler = async (ctx) => {
      // Both requests hang concurrently; neither cancels the other.
      const [first] = await Promise.all([
        askPermission(ctx, harnessRef.h!),
        ctx.client.request(methods.client.session.requestPermission, {
          sessionId: ctx.params.sessionId,
          toolCall: { toolCallId: 'edit-2', title: 'Edit file: src/b.ts', kind: 'edit', status: 'pending' },
          options: [
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          ],
        }).then((response) => {
          harnessRef.h!.agentState.permissionResponses.push(response);
          return response;
        }),
      ]);
      return { stopReason: first.outcome.outcome === 'cancelled' ? 'cancelled' : 'end_turn' };
    };
    const h = await setup({ onPrompt });
    harnessRef.h = h;

    const turn = h.acpClient.send([{ type: 'text', text: 'edit both' }]);
    await waitForPermissionEvents(h, 2);

    // Answering the second leaves the first pending — no first-wins cancellation.
    h.acpClient.resolvePermission('edit-2', 'reject_once');
    await waitForPermissionEvents(h, 3);
    const events = permissionEvents(h);
    expect(events.filter((e) => e.sessionUpdate === 'permission_requested')).toHaveLength(2);
    expect(events.filter((e) => e.sessionUpdate === 'permission_resolved')).toEqual([
      { sessionUpdate: 'permission_resolved', toolCallId: 'edit-2', response: { outcome: 'selected', kind: 'reject_once' } },
    ]);
    expect(h.statuses.at(-1)).toBe('requires_action'); // the other one is still pending

    h.acpClient.resolvePermission('edit-1', 'allow_once');
    await turn;
    expect(h.agentState.permissionResponses).toEqual([
      { outcome: { outcome: 'selected', optionId: 'reject-once' } },
      { outcome: { outcome: 'selected', optionId: 'allow-once' } },
    ]);
    expect(h.statuses.at(-1)).toBe('idle');
    h.closeAll();
  });

  it('settles every pending permission as cancelled when the transport dies (issue #18)', async () => {
    const harnessRef: { h?: Harness } = {};
    const onPrompt: PromptHandler = async (ctx) => {
      await Promise.all([
        askPermission(ctx, harnessRef.h!),
        ctx.client.request(methods.client.session.requestPermission, {
          sessionId: ctx.params.sessionId,
          toolCall: { toolCallId: 'edit-2', title: 'Edit file: src/b.ts', kind: 'edit', status: 'pending' },
          options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
        }).then((response) => {
          harnessRef.h!.agentState.permissionResponses.push(response);
          return response;
        }),
      ]);
      return { stopReason: 'end_turn' };
    };
    const h = await setup({ onPrompt });
    harnessRef.h = h;

    const turn = h.acpClient.send([{ type: 'text', text: 'edit both' }]);
    await waitForPermissionEvents(h, 2);

    h.killTransport();
    await turn;

    // The agent side can no longer receive anything (its stream is dead);
    // what matters is that the client settled BOTH waiters and folded both
    // cancellations into the document instead of leaving cards hanging.
    expect(permissionEvents(h).filter((e) => e.sessionUpdate === 'permission_resolved')).toEqual([
      { sessionUpdate: 'permission_resolved', toolCallId: 'edit-1', response: { outcome: 'cancelled' } },
      { sessionUpdate: 'permission_resolved', toolCallId: 'edit-2', response: { outcome: 'cancelled' } },
    ]);
    expect(h.statuses.at(-1)).toBe('idle');
    h.closeAll();
  });

  it('supersedes a duplicate request for the same tool call — old cancelled, new answerable (issue #18)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const harnessRef: { h?: Harness } = {};
    const onPrompt: PromptHandler = async (ctx) => {
      const first = askPermission(ctx, harnessRef.h!);
      await waitFor(() => permissionEvents(harnessRef.h!).length >= 1);
      const second = askPermission(ctx, harnessRef.h!); // same toolCallId: edit-1
      await Promise.all([first, second]);
      return { stopReason: 'end_turn' };
    };
    const h = await setup({ onPrompt });
    harnessRef.h = h;

    const turn = h.acpClient.send([{ type: 'text', text: 'edit it' }]);
    // requested → superseded (cancelled) → requested again
    await waitForPermissionEvents(h, 3);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('superseding the stale waiter'));

    h.acpClient.resolvePermission('edit-1', 'allow_once');
    await turn;

    const events = permissionEvents(h);
    expect(events).toHaveLength(4);
    expect(events[1]).toEqual({
      sessionUpdate: 'permission_resolved',
      toolCallId: 'edit-1',
      response: { outcome: 'cancelled' },
    });
    expect(h.agentState.permissionResponses).toEqual([
      { outcome: { outcome: 'cancelled' } },
      { outcome: { outcome: 'selected', optionId: 'allow-once' } },
    ]);
    expect(h.statuses.at(-1)).toBe('idle');
    warnSpy.mockRestore();
    h.closeAll();
  });

  it('answers a sessionless lookup by toolCallId suffix, loudly (issue #18)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const harnessRef: { h?: Harness } = {};
    const onPrompt: PromptHandler = async (ctx) => {
      await askPermission(ctx, harnessRef.h!);
      return { stopReason: 'end_turn' };
    };
    const h = await setup({ onPrompt, capabilities: { delete: true } });
    harnessRef.h = h;

    const turn = h.acpClient.send([{ type: 'text', text: 'edit it' }]);
    await waitForPermissionEvents(h, 1);

    // Deleting the active session clears the client's session routing; the
    // UI still answers by toolCallId, so the exact key misses and the
    // suffix scan carries the answer — announced, never silent.
    await h.acpClient.deleteSession('s-1');
    h.acpClient.resolvePermission('edit-1', 'allow_once');
    await turn;

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('by toolCallId suffix'));
    expect(h.agentState.permissionResponses).toEqual([
      { outcome: { outcome: 'selected', optionId: 'allow-once' } },
    ]);
    expect(h.statuses.at(-1)).toBe('idle');
    warnSpy.mockRestore();
    h.closeAll();
  });

  it('settles the waiter as cancelled when the agent aborts its request ($/cancel_request, issue #18)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const outgoing: AnyMessage[] = [];
    const harnessRef: { h?: Harness } = {};
    const onPrompt: PromptHandler = async (ctx) => {
      const pending = askPermission(ctx, harnessRef.h!);
      await waitFor(() => permissionEvents(harnessRef.h!).length >= 1);
      const request = outgoing.find(
        (message): message is AnyMessage & { id: number | string; method: string } =>
          'method' in message && message.method === 'session/request_permission',
      );
      if (!request) throw new Error('permission request never hit the wire');
      await ctx.client.notify('$/cancel_request', { requestId: request.id });
      await pending;
      return { stopReason: 'end_turn' };
    };
    const h = await setup({ onPrompt, spyAgentOutgoing: (message) => outgoing.push(message) });
    harnessRef.h = h;

    await h.acpClient.send([{ type: 'text', text: 'edit it' }]);

    expect(permissionEvents(h)).toEqual([
      { sessionUpdate: 'permission_requested', request: expect.objectContaining({ toolCallId: 'edit-1' }) },
      { sessionUpdate: 'permission_resolved', toolCallId: 'edit-1', response: { outcome: 'cancelled' } },
    ]);
    expect(h.agentState.permissionResponses).toEqual([{ outcome: { outcome: 'cancelled' } }]);
    expect(h.statuses).toContain('requires_action');
    expect(h.statuses.at(-1)).toBe('idle');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('aborted by the agent'));
    warnSpy.mockRestore();
    h.closeAll();
  });

  it('answers a foreign-session permission request cancelled without folding it into the stream', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let foreignResponse: RequestPermissionResponse | undefined;
    const onPrompt: PromptHandler = async (ctx) => {
      foreignResponse = await ctx.client.request(methods.client.session.requestPermission, {
        sessionId: 'not-our-session',
        toolCall: { toolCallId: 'edit-9', title: 'Edit file: src/x.ts', kind: 'edit', status: 'pending' },
        options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
      });
      return { stopReason: 'end_turn' };
    };
    const h = await setup({ onPrompt });

    await h.acpClient.send([{ type: 'text', text: 'edit it' }]);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('answered cancelled'));
    expect(foreignResponse).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(permissionEvents(h)).toEqual([]); // never folded into this stream
    warnSpy.mockRestore();
    h.closeAll();
  });

  it('ignores resolvePermission for an unknown tool call; cancels when the kind was not offered', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const harnessRef: { h?: Harness } = {};
    const onPrompt: PromptHandler = async (ctx) => {
      await askPermission(ctx, harnessRef.h!);
      return { stopReason: 'end_turn' };
    };
    const h = await setup({ onPrompt });
    harnessRef.h = h;

    h.acpClient.resolvePermission('ghost', 'allow_once'); // unknown — ignored
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ghost'));
    expect(h.updates).toEqual([]);

    const turn = h.acpClient.send([{ type: 'text', text: 'edit it' }]);
    await waitForPermissionEvents(h, 1);
    h.acpClient.resolvePermission('edit-1', 'allow_always'); // not among the offered options
    await turn;

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('allow_always'));
    expect(h.agentState.permissionResponses).toEqual([{ outcome: { outcome: 'cancelled' } }]);
    expect(h.statuses.at(-1)).toBe('idle');
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    h.closeAll();
  });

  it('fails fast when the agent negotiates an unsupported protocol version', async () => {
    const h = await setup({ protocolVersion: 2 });

    expect(h.disconnected.length).toBe(1);
    expect(h.disconnected[0]).toMatch(/协议 v2/);
    expect(h.connected).toEqual([]);
    h.closeAll();
  });

  it('surfaces an unexpected disconnect and ends the turn', async () => {
    const onPrompt: PromptHandler = () => new Promise(() => {}); // hangs forever
    const h = await setup({ onPrompt });

    const turn = h.acpClient.send([{ type: 'text', text: 'hi' }]);
    await waitFor(() => h.statuses.includes('running'));

    h.killTransport(); // the "ACP service" dies mid-turn
    await turn;

    expect(h.disconnected).toEqual(['与服务器的连接已断开']);
    expect(h.statuses.at(-1)).toBe('idle');
    h.closeAll();
  });

  it('preserves unknown update kinds as unsupported events and drops foreign sessions loudly', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onPrompt: PromptHandler = async (ctx) => {
      await notifyUpdate(ctx, { sessionUpdate: 'vendor_extension', payload: { x: 1 } });
      await notifyUpdate(ctx, { sessionUpdate: 'current_mode_update', currentModeId: 'code' });
      await ctx.client.notify(methods.client.session.update, {
        sessionId: 'not-our-session',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'intruder' } },
      });
      await notifyUpdate(ctx, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'real' },
      });
      return { stopReason: 'end_turn' };
    };
    const h = await setup({ onPrompt });
    await h.acpClient.send([{ type: 'text', text: 'hi' }]);

    expect(h.updates[0]).toEqual({
      sessionUpdate: 'user_message',
      content: [{ type: 'text', text: 'hi' }],
      optimistic: true,
    });
    // Unknown kinds become explicit unsupported events carrying the raw notification.
    expect(h.updates).toContainEqual(
      expect.objectContaining({
        sessionUpdate: 'unsupported',
        raw: {
          sessionId: 's-1',
          update: { sessionUpdate: 'vendor_extension', payload: { x: 1 } },
        },
      }),
    );
    // Known session-level kinds are recorded as session_state, not dropped.
    expect(h.updates).toContainEqual(
      expect.objectContaining({
        sessionUpdate: 'session_state',
        kind: 'current_mode_update',
      }),
    );
    expect(h.updates).toContainEqual(
      expect.objectContaining({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'real' },
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('vendor_extension'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not-our-session'));
    warnSpy.mockRestore();
    h.closeAll();
  });

  it('maps wire details: user_message_chunk rename, null messageId, diff content, image parts', async () => {
    const onPrompt: PromptHandler = async (ctx) => {
      await notifyUpdate(ctx, {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'earlier' },
      });
      await notifyUpdate(ctx, {
        sessionUpdate: 'agent_message_chunk',
        messageId: null,
        content: { type: 'text', text: 'chunk' },
      });
      await notifyUpdate(ctx, {
        sessionUpdate: 'agent_message_chunk',
        messageId: null,
        content: { type: 'image', data: 'aGk=', mimeType: 'image/png' },
      });
      await notifyUpdate(ctx, {
        sessionUpdate: 'tool_call',
        toolCallId: 't-9',
        title: 'Edit',
        kind: 'edit',
        content: [{ type: 'diff', path: '/tmp/a.ts', oldText: null, newText: 'new' }],
      });
      await notifyUpdate(ctx, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't-9',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'image', data: 'aGk=', mimeType: 'image/png' } }],
      });
      return { stopReason: 'end_turn' };
    };
    const h = await setup({ onPrompt });
    await h.acpClient.send([{ type: 'text', text: 'go' }]);

    expect(h.updates).toContainEqual(
      expect.objectContaining({
        sessionUpdate: 'user_message',
        content: [{ type: 'text', text: 'earlier' }],
      }),
    );
    expect(h.updates).toContainEqual(
      expect.objectContaining({
        sessionUpdate: 'agent_message_chunk',
        messageId: undefined,
        content: { type: 'text', text: 'chunk' },
      }),
    );
    expect(h.updates).toContainEqual(
      expect.objectContaining({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image', data: 'aGk=', mimeType: 'image/png' },
      }),
    );
    expect(h.updates).toContainEqual(
      expect.objectContaining({
        sessionUpdate: 'tool_call',
        toolCallId: 't-9',
        title: 'Edit',
        kind: 'edit',
      }),
    );
    // Content on a tool_call create is re-emitted as a follow-up update.
    expect(h.updates).toContainEqual(
      expect.objectContaining({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't-9',
        content: [{ type: 'diff', path: '/tmp/a.ts', oldText: null, newText: 'new' }],
      }),
    );
    expect(h.updates).toContainEqual(
      expect.objectContaining({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't-9',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'image', data: 'aGk=', mimeType: 'image/png' } }],
      }),
    );
    h.closeAll();
  });

  // -- session lifecycle -----------------------------------------------------

  it('reads capabilities and fetches the session list when advertised', async () => {
    const h = await setup({
      capabilities: { loadSession: true, list: true, resume: true, delete: true },
      listSessions: [
        { sessionId: 'old-1', cwd: '/tmp/a', title: '旧会话', updatedAt: '2026-08-01T10:00:00Z' },
        { sessionId: 'old-2', cwd: '/tmp/b' },
      ],
    });
    expect(h.capabilities).toEqual([
      { image: false, loadSession: true, list: true, resume: true, delete: true },
    ]);
    expect(h.sessions).toEqual([
      [
        { sessionId: 'old-1', cwd: '/tmp/a', title: '旧会话', updatedAt: '2026-08-01T10:00:00Z' },
        { sessionId: 'old-2', cwd: '/tmp/b', title: null, updatedAt: null },
      ],
    ]);
    h.closeAll();
  });

  it('does not call session/list without the capability', async () => {
    const h = await setup({ listSessions: [{ sessionId: 'x', cwd: '/x' }] });
    expect(h.sessions).toEqual([]);
    h.closeAll();
  });

  it('reconnect-resume keeps the transcript (no replay) when the agent supports it', async () => {
    const h = await setup({
      capabilities: { resume: true },
      resume: { sessionId: 's-99' },
    });
    expect(h.agentState.resumeRequests).toEqual(['s-99']);
    expect(h.replays).toEqual([]);
    expect(h.sessionIds).toEqual(['s-99']);
    expect(h.updates).toEqual([]); // nothing replayed — transcript untouched
    expect(h.connected).toHaveLength(1);
    h.closeAll();
  });

  it('reconnect falls back to session/load replay without the resume capability', async () => {
    const h = await setup({
      capabilities: { loadSession: true },
      resume: { sessionId: 's-99' },
      history: {
        's-99': [
          { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'earlier' } },
          { sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text: 'reply' } },
        ],
      },
    });
    expect(h.agentState.resumeRequests).toEqual([]);
    expect(h.replays).toHaveLength(1);
    // The fallback goes through the transactional stage → commit path too.
    expect(h.switchLog).toEqual([
      { kind: 'stage', sessionId: 's-99', cwd: '/tmp/project', era: 1 },
      { kind: 'commit', era: 1 },
    ]);
    expect(h.updates).toContainEqual(
      expect.objectContaining({
        sessionUpdate: 'user_message',
        content: [{ type: 'text', text: 'earlier' }],
      }),
    );
    expect(h.updates).toContainEqual(
      expect.objectContaining({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm',
        content: { type: 'text', text: 'reply' },
      }),
    );
    h.closeAll();
  });

  it('reconnect starts a fresh session when the agent supports neither', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = await setup({ resume: { sessionId: 's-99' } });
    expect(h.sessionIds).toEqual(['s-1']); // fresh session/new
    expect(h.replays).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('不支持会话恢复'));
    warnSpy.mockRestore();
    h.closeAll();
  });

  it('loadSession switches sessions and replays history onto a clean document', async () => {
    const h = await setup({
      capabilities: { loadSession: true },
      history: {
        's-2': [
          {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'old',
            content: { type: 'text', text: '历史消息' },
          },
        ],
      },
    });
    expect(h.sessionIds).toEqual(['s-1']);
    await h.acpClient.loadSession('s-2', '/tmp/other');
    expect(h.replays).toHaveLength(1);
    // The switch is staged, not adopted — only a commit settles it.
    expect(h.switchLog).toEqual([
      { kind: 'stage', sessionId: 's-2', cwd: '/tmp/other', era: 1 },
      { kind: 'commit', era: 1 },
    ]);
    expect(h.updates).toContainEqual(
      expect.objectContaining({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'old',
        content: { type: 'text', text: '历史消息' },
      }),
    );
    h.closeAll();
  });

  it('loadSession failure rolls the client back without disconnecting (issue #17)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await setup({
      capabilities: { loadSession: true },
      failLoadFor: ['s-2'],
    });
    expect(h.sessionIds).toEqual(['s-1']);
    await h.acpClient.loadSession('s-2', '/tmp/other');
    // Stage → rollback, and the connection survived the session-scoped error.
    // (The fake's handler throw surfaces as the SDK's generic Internal error.)
    expect(h.switchLog).toEqual([
      { kind: 'stage', sessionId: 's-2', cwd: '/tmp/other', era: 1 },
      { kind: 'rollback', reason: expect.any(String), era: 1 },
    ]);
    expect(h.disconnected).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      '[panda/acp] session/load failed — rolled back to the previous session',
      expect.any(Error),
    );
    errorSpy.mockRestore();
    h.closeAll();
  });

  it('send is routed back to the previous session after a failed switch', async () => {
    const prompts: { sessionId: string }[] = [];
    const h = await setup({
      capabilities: { loadSession: true },
      failLoadFor: ['s-2'],
      onPrompt: async (ctx) => {
        prompts.push({ sessionId: ctx.params.sessionId });
        return { stopReason: 'end_turn' };
      },
    });
    await h.acpClient.loadSession('s-2', '/tmp/other'); // fails, rolls back
    await h.acpClient.send([{ type: 'text', text: 'back home' }]);
    // this.sessionId was restored — the turn goes to s-1, not the dead target.
    expect(prompts).toEqual([{ sessionId: 's-1' }]);
    h.closeAll();
  });

  it('refuses a second switch, a send, a new session and a delete while one switch is still in flight', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let releaseLoad: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (releaseLoad = resolve));
    const h = await setup({
      capabilities: { loadSession: true, delete: true },
      history: { 's-2': [] },
      beforeLoad: () => gate,
    });
    const first = h.acpClient.loadSession('s-2', '/tmp/other');
    await h.acpClient.loadSession('s-2', '/tmp/other'); // refused while in flight
    await h.acpClient.send([{ type: 'text', text: 'nope' }]); // refused
    await h.acpClient.newSession('/tmp/other'); // refused
    await h.acpClient.deleteSession('s-2'); // refused (deleting the staged target)
    expect(warnSpy).toHaveBeenCalledWith(
      '[panda/acp] loadSession ignored: another switch is still in flight',
    );
    expect(warnSpy).toHaveBeenCalledWith(
      '[panda/acp] send ignored: a session switch is still in flight',
    );
    expect(warnSpy).toHaveBeenCalledWith(
      '[panda/acp] newSession ignored: a session switch is still in flight',
    );
    expect(warnSpy).toHaveBeenCalledWith(
      '[panda/acp] deleteSession ignored: a session switch is still in flight',
    );
    expect(h.updates).toEqual([]); // the refused send produced no optimistic echo
    expect(h.agentState.deleteRequests).toEqual([]);
    releaseLoad!();
    await first;
    expect(h.switchLog).toEqual([
      { kind: 'stage', sessionId: 's-2', cwd: '/tmp/other', era: 1 },
      { kind: 'commit', era: 1 },
    ]);
    warnSpy.mockRestore();
    h.closeAll();
  });

  it('routes session_info_update to onSessionInfo, not into the document stream', async () => {
    const onPrompt: PromptHandler = async (ctx) => {
      await notifyUpdate(ctx, { sessionUpdate: 'session_info_update', title: '重构 token 校验' });
      await notifyUpdate(ctx, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hi' },
      });
      return { stopReason: 'end_turn' };
    };
    const h = await setup({ onPrompt });
    await h.acpClient.send([{ type: 'text', text: 'go' }]);
    expect(h.sessionInfos).toEqual([{ sessionId: 's-1', title: '重构 token 校验' }]);
    expect(h.updates.some((u) => (u.sessionUpdate as string) === 'session_info_update')).toBe(false);
    h.closeAll();
  });

  it('deleteSession requests session/delete and reports back', async () => {
    const h = await setup({ capabilities: { delete: true } });
    await h.acpClient.deleteSession('s-1');
    expect(h.agentState.deleteRequests).toEqual(['s-1']);
    expect(h.deletedSessions).toEqual(['s-1']);
    h.closeAll();
  });

  it('deleteSession is refused without the capability', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = await setup();
    await h.acpClient.deleteSession('s-1');
    expect(h.agentState.deleteRequests).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('session/delete'));
    warnSpy.mockRestore();
    h.closeAll();
  });
});

  // -- echo reconciliation (issue #15) --------------------------------------

  it('confirms the optimistic message when the agent echoes it verbatim', async () => {
    const onPrompt: PromptHandler = async (ctx) => {
      await notifyUpdate(ctx, {
        sessionUpdate: 'user_message_chunk',
        messageId: 'pm-1',
        content: { type: 'text', text: 'hi' },
      });
      await notifyUpdate(ctx, {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm-1',
        content: { type: 'text', text: '答案' },
      });
      return { stopReason: 'end_turn' };
    };
    const h = await setup({ onPrompt });
    await h.acpClient.send([{ type: 'text', text: 'hi' }]);

    expect(h.updates).toEqual([
      { sessionUpdate: 'user_message', content: [{ type: 'text', text: 'hi' }], optimistic: true },
      {
        sessionUpdate: 'user_message_confirmed',
        protocolMessageId: 'pm-1',
        notifications: [
          {
            sessionId: 's-1',
            update: { sessionUpdate: 'user_message_chunk', messageId: 'pm-1', content: { type: 'text', text: 'hi' } },
          },
        ],
      },
      expect.objectContaining({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm-1',
        content: { type: 'text', text: '答案' },
      }),
    ]);
    h.closeAll();
  });

  it('flushes a partial echo as the protocol version when a non-echo update closes the window', async () => {
    const onPrompt: PromptHandler = async (ctx) => {
      await notifyUpdate(ctx, {
        sessionUpdate: 'user_message_chunk',
        messageId: 'pm-1',
        content: { type: 'text', text: 'hello ' },
      });
      // Any non-echo update closes the echo window while the buffer is partial.
      await notifyUpdate(ctx, {
        sessionUpdate: 'agent_thought_chunk',
        messageId: 't-1',
        content: { type: 'text', text: '思考中' },
      });
      await notifyUpdate(ctx, {
        sessionUpdate: 'user_message_chunk',
        messageId: 'pm-1',
        content: { type: 'text', text: 'world' },
      });
      return { stopReason: 'end_turn' };
    };
    const h = await setup({ onPrompt });
    await h.acpClient.send([{ type: 'text', text: 'hello world' }]);

    expect(h.updates[0]).toEqual({
      sessionUpdate: 'user_message',
      content: [{ type: 'text', text: 'hello world' }],
      optimistic: true,
    });
    // The partial echo renders as its own protocol message, in wire order,
    // and the echo window stays closed for the chunk that follows.
    expect(h.updates[1]).toMatchObject({
      sessionUpdate: 'user_message',
      content: [{ type: 'text', text: 'hello ' }],
    });
    expect(h.updates[2]).toMatchObject({ sessionUpdate: 'agent_thought_chunk' });
    expect(h.updates[3]).toMatchObject({
      sessionUpdate: 'user_message',
      content: [{ type: 'text', text: 'world' }],
    });
    expect(h.updates.some((u) => u.sessionUpdate === 'user_message_confirmed')).toBe(false);
    h.closeAll();
  });

  it('renders a divergent echo separately instead of merging into the optimistic message', async () => {
    const onPrompt: PromptHandler = async (ctx) => {
      await notifyUpdate(ctx, {
        sessionUpdate: 'user_message_chunk',
        messageId: 'pm-1',
        content: { type: 'text', text: '别的' },
      });
      return { stopReason: 'end_turn' };
    };
    const h = await setup({ onPrompt });
    await h.acpClient.send([{ type: 'text', text: 'hi' }]);

    expect(h.updates).toEqual([
      { sessionUpdate: 'user_message', content: [{ type: 'text', text: 'hi' }], optimistic: true },
      { sessionUpdate: 'user_message', content: [{ type: 'text', text: '别的' }], raw: expect.any(Object) },
    ]);
    h.closeAll();
  });

  it('flushes an un-reconciled partial echo when the turn settles', async () => {
    const onPrompt: PromptHandler = async (ctx) => {
      await notifyUpdate(ctx, {
        sessionUpdate: 'user_message_chunk',
        messageId: 'pm-1',
        content: { type: 'text', text: 'hel' },
      });
      return { stopReason: 'end_turn' };
    };
    const h = await setup({ onPrompt });
    await h.acpClient.send([{ type: 'text', text: 'hello' }]);

    // The partial echo was held (prefix); the turn ending must render it.
    expect(h.updates).toEqual([
      { sessionUpdate: 'user_message', content: [{ type: 'text', text: 'hello' }], optimistic: true },
      { sessionUpdate: 'user_message', content: [{ type: 'text', text: 'hel' }], raw: expect.any(Object) },
    ]);
    h.closeAll();
  });

  it('flushes an un-reconciled partial echo when the prompt turn fails', async () => {
    const onPrompt: PromptHandler = async (ctx) => {
      await notifyUpdate(ctx, {
        sessionUpdate: 'user_message_chunk',
        messageId: 'pm-1',
        content: { type: 'text', text: 'hel' },
      });
      throw new Error('agent exploded');
    };
    const h = await setup({ onPrompt });
    await h.acpClient.send([{ type: 'text', text: 'hello' }]);

    expect(h.updates).toEqual([
      { sessionUpdate: 'user_message', content: [{ type: 'text', text: 'hello' }], optimistic: true },
      { sessionUpdate: 'user_message', content: [{ type: 'text', text: 'hel' }], raw: expect.any(Object) },
    ]);
    expect(h.statuses.at(-1)).toBe('idle');
    h.closeAll();
  });

// -- store integration (issue #16) ------------------------------------------

describe('LiveAcpClient × connectionStorePort', () => {
  /**
   * The three transactional-switch handlers, wired exactly the way
   * useLiveSession wires them (issue #19): the staged snapshot carries the
   * era it was staged under, and a settle whose era no longer matches was
   * abandoned — ignored, never consumed.
   */
  function wireSwitchHandlers(port: ConnectionStorePort) {
    let staged: { snapshot: SessionSwitchSnapshot; era: number } | null = null;
    return {
      onSessionSwitchStage: (id: string, cwd: string, era: number) => {
        staged = { snapshot: port.stageSession(id, cwd), era };
      },
      onSessionSwitchCommit: (era: number) => {
        if (!staged || staged.era !== era) {
          console.info(`[panda/acp] session switch commit from era ${era} ignored (staged: ${staged ? `era ${staged.era}` : 'none'})`);
          return;
        }
        const snapshot = staged.snapshot;
        staged = null;
        port.commitStagedSession(snapshot);
      },
      onSessionSwitchRollback: (reason: string, era: number) => {
        if (!staged || staged.era !== era) {
          console.info(`[panda/acp] session switch rollback from era ${era} ignored (staged: ${staged ? `era ${staged.era}` : 'none'})`);
          return;
        }
        const snapshot = staged.snapshot;
        staged = null;
        port.rollbackStagedSession(snapshot);
        port.setConnection({ error: `切换会话失败: ${reason}` });
      },
      /**
       * Mirrors useLiveSession's connect-entry abandonment (issue #19): call
       * right before a replacing acpClient.connect — invalidates first so the
       * rollback below lands stale (documents only, pointers untouched).
       */
      abandonStaged: () => {
        if (!staged) return;
        const snapshot = staged.snapshot;
        staged = null;
        port.invalidateSelections();
        port.rollbackStagedSession(snapshot);
      },
    };
  }

  beforeEach(() => {
    usePanda.setState({
      mode: 'demo',
      connections: {},
      activeConnectionId: null,
      activeSessionId: null,
      selectionGeneration: 0,
    });
  });

  it('replays session/load onto a clean document on every revisit (A→B→A, no duplication)', async () => {
    usePanda.getState().ensureConnection('live');
    const port = connectionStorePort('live');
    const historyFor = (sessionId: string) => [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: `prompt-${sessionId}` } },
      { sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text: `reply-${sessionId}` } },
    ];
    const { clientStream, serverStream } = streamPair();
    agent({ name: 'fake-agent' })
      .onRequest(methods.agent.initialize, () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'fake-agent', version: '0.0.0' },
        agentCapabilities: { loadSession: true },
      }))
      .onRequest(methods.agent.session.new, () => ({ sessionId: 'A' }))
      .onRequest(methods.agent.session.load, async (ctx) => {
        for (const update of historyFor(ctx.params.sessionId)) {
          await ctx.client.notify(methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update,
          });
        }
        return {};
      })
      .onRequest(methods.agent.session.prompt, () => ({ stopReason: 'end_turn' }))
      .connect(serverStream);
    const acpClient = new LiveAcpClient({
      onUpdate: (update) => port.update(update),
      onStatus: () => {},
      onConnected: () => {},
      onSessionId: (id, cwd) => port.adoptSession(id, cwd),
      onDisconnected: () => {},
      onCapabilities: () => {},
      onSessions: () => {},
      onSessionInfo: () => {},
      onReplayStart: () => port.resetDocument(),
      onSessionDeleted: () => {},
      ...wireSwitchHandlers(port),
    });
    await acpClient.connect(new StreamTransport(clientStream), '/tmp/project');

    await acpClient.loadSession('B', '/tmp/project');
    await acpClient.loadSession('A', '/tmp/project'); // revisit — must not duplicate

    const docs = usePanda.getState().connections['live']!.docs;
    const userText = (id: string) =>
      docs[id]!.turns
        .flatMap((turn) => turn.blocks)
        .filter((b): b is Extract<typeof b, { kind: 'user_message' }> => b.kind === 'user_message')
        .flatMap((b) => b.content.filter((c): c is { type: 'text', text: string } => c.type === 'text'))
        .map((c) => c.text);
    expect(userText('A')).toEqual(['prompt-A']); // exactly once, not twice
    expect(userText('B')).toEqual(['prompt-B']);
    expect(usePanda.getState().activeSessionId).toBe('A');
    acpClient.disconnect();
  });

  it('rolls back to the previous session when session/load fails, and the switch is retryable (issue #17)', async () => {
    usePanda.getState().ensureConnection('live');
    const port = connectionStorePort('live');
    const failLoadFor = ['B'];
    const { clientStream, serverStream } = streamPair();
    agent({ name: 'fake-agent' })
      .onRequest(methods.agent.initialize, () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'fake-agent', version: '0.0.0' },
        agentCapabilities: { loadSession: true },
      }))
      .onRequest(methods.agent.session.new, () => ({ sessionId: 'A' }))
      .onRequest(methods.agent.session.load, async (ctx) => {
        if (failLoadFor.includes(ctx.params.sessionId)) throw new Error('session 不存在');
        await ctx.client.notify(methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: `prompt-${ctx.params.sessionId}` } },
        });
        return {};
      })
      .connect(serverStream);
    const acpClient = new LiveAcpClient({
      onUpdate: (update) => port.update(update),
      onStatus: () => {},
      onConnected: () => {},
      onSessionId: (id, cwd) => port.adoptSession(id, cwd),
      onDisconnected: () => {},
      onCapabilities: () => {},
      onSessions: () => {},
      onSessionInfo: () => {},
      onReplayStart: () => port.resetDocument(),
      onSessionDeleted: () => {},
      ...wireSwitchHandlers(port),
    });
    await acpClient.connect(new StreamTransport(clientStream), '/tmp/project');
    port.update({ sessionUpdate: 'user_message', content: [{ type: 'text', text: 'original turn' }] });
    const before = usePanda.getState().connections['live']!.docs['A']!;

    await acpClient.loadSession('B', '/tmp/project'); // fails

    const state = usePanda.getState();
    const slot = state.connections['live']!;
    // The previous session is fully intact: transcript identity, pointer,
    // connection.sessionId — and no half-staged document or switch state.
    expect(slot.docs['A']).toBe(before);
    expect(slot.docs['B']).toBeUndefined();
    expect(slot.connection.sessionId).toBe('A');
    expect(slot.switching).toBeNull();
    expect(state.activeSessionId).toBe('A');
    expect(slot.connection.error).toContain('切换会话失败');

    // Retry after the agent recovers: the switch succeeds this time.
    failLoadFor.length = 0;
    await acpClient.loadSession('B', '/tmp/project');
    const after = usePanda.getState();
    expect(after.connections['live']!.connection.sessionId).toBe('B');
    expect(after.activeSessionId).toBe('B');
    expect(after.connections['live']!.docs['B']!.turns).toHaveLength(1);
    expect(after.connections['live']!.connection.error).toBeNull();
    acpClient.disconnect();
  });

  it('keeps the transcript when reconnecting via session/resume (no replay)', async () => {
    usePanda.getState().ensureConnection('live');
    const port = connectionStorePort('live');
    let replays = 0;
    const { clientStream, serverStream } = streamPair();
    agent({ name: 'fake-agent' })
      .onRequest(methods.agent.initialize, () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'fake-agent', version: '0.0.0' },
        agentCapabilities: { sessionCapabilities: { resume: {} } },
      }))
      .onRequest(methods.agent.session.resume, () => ({}))
      .connect(serverStream);
    const acpClient = new LiveAcpClient({
      onUpdate: (update) => port.update(update),
      onStatus: () => {},
      onConnected: () => {},
      onSessionId: (id, cwd) => port.adoptSession(id, cwd),
      onDisconnected: () => {},
      onCapabilities: () => {},
      onSessions: () => {},
      onSessionInfo: () => {},
      onReplayStart: () => { replays += 1; },
      onSessionDeleted: () => {},
      ...wireSwitchHandlers(port),
    });
    // Pre-existing transcript from the previous connection to this session.
    port.adoptSession('A', '/tmp/project');
    port.update({ sessionUpdate: 'user_message', content: [{ type: 'text', text: 'kept turn' }] });
    const before = usePanda.getState().connections['live']!.docs['A']!;

    await acpClient.connect(new StreamTransport(clientStream), '/tmp/project', { sessionId: 'A' });

    expect(replays).toBe(0); // resume restores agent context, never replays
    expect(usePanda.getState().connections['live']!.docs['A']).toBe(before);
    expect(usePanda.getState().activeSessionId).toBe('A');
    acpClient.disconnect();
  });

  it('restores the transcript when a resume-fallback session/load fails during connect', async () => {
    usePanda.getState().ensureConnection('live');
    const port = connectionStorePort('live');
    const { clientStream, serverStream } = streamPair();
    agent({ name: 'fake-agent' })
      .onRequest(methods.agent.initialize, () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'fake-agent', version: '0.0.0' },
        agentCapabilities: { loadSession: true }, // no resume — falls back to load
      }))
      .onRequest(methods.agent.session.load, () => {
        throw new Error('session 不存在');
      })
      .connect(serverStream);
    const acpClient = new LiveAcpClient({
      onUpdate: (update) => port.update(update),
      onStatus: () => {},
      onConnected: () => {},
      onSessionId: (id, cwd) => port.adoptSession(id, cwd),
      onDisconnected: (reason) =>
        port.setConnection(
          reason
            ? { status: 'error', error: reason }
            : { status: 'disconnected', error: null, sessionId: null },
        ),
      onCapabilities: () => {},
      onSessions: () => {},
      onSessionInfo: () => {},
      onReplayStart: () => port.resetDocument(),
      onSessionDeleted: () => {},
      ...wireSwitchHandlers(port),
    });
    port.adoptSession('A', '/tmp/project');
    port.update({ sessionUpdate: 'user_message', content: [{ type: 'text', text: 'kept turn' }] });
    const before = usePanda.getState().connections['live']!.docs['A']!;

    await acpClient.connect(new StreamTransport(clientStream), '/tmp/project', { sessionId: 'A' }); // load fails

    const slot = usePanda.getState().connections['live']!;
    expect(slot.docs['A']).toBe(before); // rolled back, not wiped
    expect(slot.switching).toBeNull();
    expect(slot.connection.status).toBe('error');
    expect(slot.connection.sessionId).toBe('A'); // resumable pointer kept
    expect(usePanda.getState().activeSessionId).toBe('A');
    acpClient.disconnect();
  });

  it('treats a late initialize from a superseded connect as superseded, not an error (issue #19)', async () => {
    // Era 1's initialize hangs; era 2 (a reconnect) supersedes it before the
    // response ever lands.
    let releaseEra1!: () => void;
    const era1Gate = new Promise<void>((resolve) => (releaseEra1 = resolve));
    let era1InitSeen = false;
    const { clientStream: era1Client, serverStream: era1Server } = streamPair();
    const era1ServerConnection = agent({ name: 'slow-agent' })
      .onRequest(methods.agent.initialize, () => {
        era1InitSeen = true;
        return era1Gate.then(() => ({
          protocolVersion: PROTOCOL_VERSION,
          agentInfo: { name: 'slow-agent', version: '0.0.0' },
          agentCapabilities: {},
        }));
      })
      .onRequest(methods.agent.session.new, () => ({ sessionId: 's-slow' }))
      .connect(era1Server);

    const connected: string[] = [];
    const sessionIds: string[] = [];
    const disconnected: (string | null)[] = [];
    const acpClient = new LiveAcpClient({
      onUpdate: () => {},
      onStatus: () => {},
      onConnected: (info) => connected.push(info.agentName),
      onSessionId: (id) => sessionIds.push(id),
      onDisconnected: (reason) => disconnected.push(reason),
      onCapabilities: () => {},
      onSessions: () => {},
      onSessionInfo: () => {},
      onReplayStart: () => {},
      onSessionDeleted: () => {},
      onSessionSwitchStage: () => {},
      onSessionSwitchCommit: () => {},
      onSessionSwitchRollback: () => {},
    });
    const era1 = acpClient.connect(new StreamTransport(era1Client), '/tmp/project');
    await waitFor(() => era1InitSeen);

    // Era 2: a plain reconnect on a second server — it wins the race.
    const { clientStream: era2Client, serverStream: era2Server } = streamPair();
    agent({ name: 'fake-agent-2' })
      .onRequest(methods.agent.initialize, () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'fake-agent-2', title: 'Fake Agent 2', version: '0.0.0' },
        agentCapabilities: {},
      }))
      .onRequest(methods.agent.session.new, () => ({ sessionId: 's-3' }))
      .connect(era2Server);
    await acpClient.connect(new StreamTransport(era2Client), '/tmp/project');

    releaseEra1(); // era 1's initialize finally resolves — superseded
    await era1;
    era1ServerConnection.close();

    expect(connected).toEqual(['Fake Agent 2']); // era 1 never surfaced
    expect(sessionIds).toEqual(['s-3']);
    expect(disconnected).toEqual([]); // superseded ≠ disconnect, no error report
    acpClient.disconnect();
  });

  it('reports a transport-level failure as a connect failure, never an unhandled rejection (issue #20)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const disconnected: (string | null)[] = [];
    const acpClient = new LiveAcpClient({
      onUpdate: () => {},
      onStatus: () => {},
      onConnected: () => {},
      onSessionId: () => {},
      onDisconnected: (reason) => disconnected.push(reason),
      onCapabilities: () => {},
      onSessions: () => {},
      onSessionInfo: () => {},
      onReplayStart: () => {},
      onSessionDeleted: () => {},
      onSessionSwitchStage: () => {},
      onSessionSwitchCommit: () => {},
      onSessionSwitchRollback: () => {},
    });

    await acpClient.connect(new FailingTransport(new Error('Invalid URL')), '/tmp/project');

    expect(disconnected).toEqual(['连接失败: Invalid URL']);
    errorSpy.mockRestore();
  });

  it('discards a connect superseded while its transport was still opening (issue #20)', async () => {
    let releaseEra1!: () => void;
    const era1Gate = new Promise<void>((resolve) => (releaseEra1 = resolve));
    const era1Transport = new GatedFailingTransport(era1Gate, new Error('era-1 transport died'));
    const connected: string[] = [];
    const disconnected: (string | null)[] = [];
    const acpClient = new LiveAcpClient({
      onUpdate: () => {},
      onStatus: () => {},
      onConnected: (info) => connected.push(info.agentName),
      onSessionId: () => {},
      onDisconnected: (reason) => disconnected.push(reason),
      onCapabilities: () => {},
      onSessions: () => {},
      onSessionInfo: () => {},
      onReplayStart: () => {},
      onSessionDeleted: () => {},
      onSessionSwitchStage: () => {},
      onSessionSwitchCommit: () => {},
      onSessionSwitchRollback: () => {},
    });
    const era1 = acpClient.connect(era1Transport, '/tmp/project');

    // Era 2 replaces the connection BEFORE era 1's transport even opened:
    // the cleanup must reach the pending attempt's transport (owned before
    // its connect() resolves) and the late rejection must be discarded.
    const { clientStream: era2Client, serverStream: era2Server } = streamPair();
    agent({ name: 'fake-agent-2' })
      .onRequest(methods.agent.initialize, () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'fake-agent-2', title: 'Fake Agent 2', version: '0.0.0' },
        agentCapabilities: {},
      }))
      .onRequest(methods.agent.session.new, () => ({ sessionId: 's-2' }))
      .connect(era2Server);
    await acpClient.connect(new StreamTransport(era2Client), '/tmp/project');
    releaseEra1();
    await era1;

    expect(connected).toEqual(['Fake Agent 2']);
    expect(disconnected).toEqual([]); // era-1's failure belongs to a dead era
    expect(era1Transport.disconnect).toHaveBeenCalledTimes(1); // torn down by era-2's cleanup
    acpClient.disconnect();
  });

  it('drops session updates that drain from a superseded connection era (issue #19)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let releaseChunk!: () => void;
    const chunkGate = new Promise<void>((resolve) => (releaseChunk = resolve));
    const onPrompt: PromptHandler = async (ctx) => {
      await chunkGate;
      await notifyUpdate(ctx, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'stale era' },
      });
      return { stopReason: 'end_turn' };
    };
    const h = await setup({ onPrompt });

    const turn = h.acpClient.send([{ type: 'text', text: 'hi' }]);
    await waitFor(() => h.statuses.includes('running'));
    // What a reconnect's cleanup does to the era — the generation moves on
    // while the old socket (still open here) drains its buffered events.
    (h.acpClient as unknown as { connectionGeneration: number }).connectionGeneration += 1;
    releaseChunk();
    await turn;

    expect(h.updates).toEqual([
      { sessionUpdate: 'user_message', content: [{ type: 'text', text: 'hi' }], optimistic: true },
    ]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('session/update from a superseded connection — dropped'),
    );
    warnSpy.mockRestore();
    h.closeAll();
  });

  it('rolls back a session/load that outlives its connection era (issue #19)', async () => {
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => (releaseLoad = resolve));
    const h = await setup({
      capabilities: { loadSession: true },
      history: {
        's-2': [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 's-2 history' } }],
      },
      beforeLoad: () => loadGate,
    });

    const switching = h.acpClient.loadSession('s-2', '/tmp/project');
    await waitFor(() => h.switchLog.some((entry) => entry.kind === 'stage'));

    // The era is superseded while the load is still in flight (what a
    // reconnect's cleanup does first): success must roll back, not commit.
    (h.acpClient as unknown as { connectionGeneration: number }).connectionGeneration += 1;
    releaseLoad();
    await switching;

    expect(h.switchLog).toEqual([
      { kind: 'stage', sessionId: 's-2', cwd: '/tmp/project', era: 1 },
      { kind: 'rollback', reason: '连接已被更新的连接替换', era: 1 },
    ]);
    expect(h.sessionIds).toEqual(['s-1']); // nothing settled onto the target
    h.closeAll();
  });

  it('discards a session/new that completes after the connection was replaced (issue #19)', async () => {
    let releaseNew!: () => void;
    const newGate = new Promise<void>((resolve) => (releaseNew = resolve));
    let newCalls = 0;
    const h = await setup({
      // Gate only the second session/new (the first belongs to connect).
      beforeNewSession: () => {
        newCalls += 1;
        return newCalls > 1 ? newGate : Promise.resolve();
      },
    });

    const creating = h.acpClient.newSession('/tmp/project');
    await waitFor(() => newCalls === 2);
    (h.acpClient as unknown as { connectionGeneration: number }).connectionGeneration += 1;
    releaseNew();
    await creating;

    // The created session was never adopted — only the initial connect's.
    expect(h.sessionIds).toEqual(['s-1']);
    h.closeAll();
  });

  it('answers a permission request that arrives from a superseded era cancelled (issue #19)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let releaseAsk!: () => void;
    const askGate = new Promise<void>((resolve) => (releaseAsk = resolve));
    const harnessRef: { h?: Harness } = {};
    const onPrompt: PromptHandler = async (ctx) => {
      await askGate; // the request arrives only after the era moved on
      const response = await askPermission(ctx, harnessRef.h!);
      return { stopReason: response.outcome.outcome === 'cancelled' ? 'cancelled' : 'end_turn' };
    };
    const h = await setup({ onPrompt });
    harnessRef.h = h;

    const turn = h.acpClient.send([{ type: 'text', text: 'edit it' }]);
    await waitFor(() => h.statuses.includes('running'));
    // What a reconnect's cleanup does to the era while the agent is still
    // about to ask: the request must be answered cancelled, never folded.
    (h.acpClient as unknown as { connectionGeneration: number }).connectionGeneration += 1;
    releaseAsk();
    await turn;

    expect(h.agentState.permissionResponses).toEqual([{ outcome: { outcome: 'cancelled' } }]);
    expect(permissionEvents(h)).toEqual([]); // no card rendered for a dead era
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('session/request_permission from a superseded connection — answered cancelled'),
    );
    warnSpy.mockRestore();
    h.closeAll();
  });

  it('a reconnect interrupts an in-flight switch: era-1 rolls back stale, era-2 owns the state (issue #19)', async () => {
    usePanda.getState().ensureConnection('live');
    const port = connectionStorePort('live');
    // Era-1's session/load never answers: it stays pending until the
    // replacement's close() rejects it client-side — that rejection is the
    // deterministic seam under test (SDK close rejects ALL pending requests).
    const era1LoadHangs = new Promise<{}>(() => {});
    const { clientStream: era1Client, serverStream: era1Server } = streamPair();
    const era1ServerConnection = agent({ name: 'fake-agent' })
      .onRequest(methods.agent.initialize, () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'fake-agent', version: '0.0.0' },
        agentCapabilities: { loadSession: true },
      }))
      .onRequest(methods.agent.session.new, () => ({ sessionId: 'A' }))
      .onRequest(methods.agent.session.load, () => era1LoadHangs)
      .connect(era1Server);
    const disconnected: (string | null)[] = [];
    const switchWiring = wireSwitchHandlers(port);
    const acpClient = new LiveAcpClient({
      onUpdate: (update) => port.update(update),
      onStatus: () => {},
      onConnected: (info) =>
        port.setConnection({ status: 'connected', agentName: info.agentName, protocolVersion: info.protocolVersion, error: null }),
      onSessionId: (id, cwd) => port.adoptSession(id, cwd),
      onDisconnected: (reason) => {
        disconnected.push(reason);
        port.setConnection(
          reason
            ? { status: 'error', error: reason }
            : { status: 'disconnected', error: null, sessionId: null },
        );
      },
      onCapabilities: () => {},
      onSessions: () => {},
      onSessionInfo: () => {},
      onReplayStart: () => port.resetDocument(),
      onSessionDeleted: () => {},
      ...switchWiring,
    });
    await acpClient.connect(new StreamTransport(era1Client), '/tmp/project');
    port.update({ sessionUpdate: 'user_message', content: [{ type: 'text', text: 'era-1 turn' }] });
    const era1Doc = usePanda.getState().connections['live']!.docs['A']!;

    const switching = acpClient.loadSession('B', '/tmp/project');
    await waitFor(() => usePanda.getState().connections['live']!.switching !== null);

    // The reconnect, in driver order: abandon the staged switch first
    // (invalidate → stale rollback), then replace the connection — era-1's
    // pending load is rejected deterministically by close().
    switchWiring.abandonStaged();
    const { clientStream: era2Client, serverStream: era2Server } = streamPair();
    agent({ name: 'fake-agent-2' })
      .onRequest(methods.agent.initialize, () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'fake-agent-2', version: '0.0.0' },
        agentCapabilities: {},
      }))
      .onRequest(methods.agent.session.new, () => ({ sessionId: 'C' }))
      .connect(era2Server);
    await acpClient.connect(new StreamTransport(era2Client), '/tmp/project');
    await switching;
    era1ServerConnection.close();

    const slot = usePanda.getState().connections['live']!;
    expect(slot.connection.status).toBe('connected'); // era-2 owns the state
    expect(slot.connection.sessionId).toBe('C');
    expect(usePanda.getState().activeSessionId).toBe('C');
    expect(slot.switching).toBeNull(); // no busy lock left behind
    expect(slot.docs['A']).toBe(era1Doc); // the dead era's transcript survives
    expect(slot.docs['B']).toBeUndefined(); // the abandoned placeholder is gone
    expect(disconnected).toEqual([]); // replacement ≠ disconnect
    acpClient.disconnect();
  });
});
