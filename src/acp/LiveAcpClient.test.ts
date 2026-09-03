import { describe, expect, it, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  agent,
  methods,
  type AgentConnection,
  type AgentRequestContext,
  type AnyMessage,
  type PromptRequest,
  type RequestPermissionResponse,
  type Stream,
} from '@agentclientprotocol/sdk';
import { LiveAcpClient, type LiveClientHandlers } from './LiveAcpClient';
import type {
  AcpSessionUpdate,
  PermissionRequest,
  SessionStatus,
} from '../protocol/types';

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
  permissions: (PermissionRequest | null)[];
  connected: { agentName: string; protocolVersion: number }[];
  sessionIds: string[];
  disconnected: (string | null)[];
  capabilities: { image: boolean; loadSession: boolean; list: boolean; resume: boolean; delete: boolean }[];
  sessions: { sessionId: string; cwd: string; title: string | null; updatedAt: string | null }[][];
  sessionInfos: { sessionId: string; title?: string | null; updatedAt?: string | null }[];
  replays: number[];
  deletedSessions: string[];
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
  /** Reconnect target passed to LiveAcpClient.connect. */
  resume?: { sessionId: string };
  onPrompt?: PromptHandler;
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

async function setup(opts: FakeAgentOptions = {}): Promise<Harness> {
  const records: Records = {
    updates: [],
    statuses: [],
    permissions: [],
    connected: [],
    sessionIds: [],
    disconnected: [],
    capabilities: [],
    sessions: [],
    sessionInfos: [],
    replays: [],
    deletedSessions: [],
  };
  const handlers: LiveClientHandlers = {
    onUpdate: (update) => records.updates.push(update),
    onStatus: (status) => records.statuses.push(status),
    onPermission: (request) => records.permissions.push(request),
    onConnected: (info) => records.connected.push(info),
    onSessionId: (id) => records.sessionIds.push(id),
    onDisconnected: (reason) => records.disconnected.push(reason),
    onCapabilities: (caps) => records.capabilities.push(caps),
    onSessions: (entries) => records.sessions.push(entries),
    onSessionInfo: (sessionId, info) => records.sessionInfos.push({ sessionId, ...info }),
    onReplayStart: () => records.replays.push(records.replays.length + 1),
    onSessionDeleted: (sessionId) => records.deletedSessions.push(sessionId),
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

  const { clientStream, serverStream } = streamPair();
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
    .onRequest(methods.agent.session.new, () => ({ sessionId: 's-1' }))
    .onRequest(methods.agent.session.list, () => ({
      sessions: opts.listSessions ?? [],
    }))
    .onRequest(methods.agent.session.load, async (ctx) => {
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

  const acpClient = new LiveAcpClient(handlers);
  await acpClient.connect(clientStream, '/tmp/project', opts.resume);

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
    expect(h.updates[0]).toEqual({ sessionUpdate: 'user_message', content });
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
    await waitFor(() => h.permissions.length > 0 && h.permissions[0] !== null);

    expect(h.statuses).toContain('requires_action');
    expect(h.permissions[0]).toEqual({
      toolCallId: 'edit-1',
      title: 'Edit file: src/a.ts',
      options: [
        { id: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { id: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    });

    h.acpClient.resolvePermission('allow_once');
    await turn;

    expect(h.agentState.permissionResponses).toEqual([
      { outcome: { outcome: 'selected', optionId: 'allow-once' } },
    ]);
    expect(h.permissions.at(-1)).toBeNull();
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
    await waitFor(() => h.permissions.length > 0 && h.permissions[0] !== null);

    h.acpClient.resolvePermission('reject_once');
    await turn;

    expect(h.agentState.permissionResponses).toEqual([
      { outcome: { outcome: 'selected', optionId: 'reject-once' } },
    ]);
    expect(h.permissions.at(-1)).toBeNull();
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
    await waitFor(() => h.permissions.length > 0 && h.permissions[0] !== null);

    h.acpClient.cancel();
    await turn;

    expect(h.agentState.cancelNotifications).toEqual([{ sessionId: 's-1' }]);
    expect(h.agentState.permissionResponses).toEqual([{ outcome: { outcome: 'cancelled' } }]);
    expect(h.permissions.at(-1)).toBeNull();
    expect(h.statuses.at(-1)).toBe('idle');
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
    expect(h.sessionIds).toContain('s-99');
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
    expect(h.sessionIds).toEqual(['s-1', 's-2']);
    expect(h.updates).toContainEqual(
      expect.objectContaining({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'old',
        content: { type: 'text', text: '历史消息' },
      }),
    );
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
