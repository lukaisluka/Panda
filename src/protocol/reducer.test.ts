import { describe, expect, it, vi } from 'vitest';
import { applyUpdate, emptySession } from './reducer';
import type {
  AcpSessionUpdate,
  SessionDocument,
  SessionNotification,
} from './types';

const IMAGE = { type: 'image' as const, data: 'aGk=', mimeType: 'image/png' };

const textChunk = (messageId: string | undefined, text: string): AcpSessionUpdate => ({
  sessionUpdate: 'agent_message_chunk',
  messageId,
  content: { type: 'text', text },
});

const imageChunk = (messageId: string | undefined): AcpSessionUpdate => ({
  sessionUpdate: 'agent_message_chunk',
  messageId,
  content: IMAGE,
});

const fold = (updates: AcpSessionUpdate[]): SessionDocument =>
  updates.reduce((doc, update) => applyUpdate(doc, update), emptySession());

/** A distinguishable raw notification (the payload doubles as its label). */
const rawNote = (label: string): SessionNotification =>
  ({
    sessionId: 's-1',
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: label },
    },
  }) as unknown as SessionNotification;

const carryingRaw = (update: AcpSessionUpdate, raw: SessionNotification): AcpSessionUpdate =>
  ({ ...update, raw }) as AcpSessionUpdate;

describe('reducer content parts', () => {
  it('concatenates text chunks of the same messageId into one part', () => {
    const doc = fold([textChunk('m1', 'a'), textChunk('m1', 'b')]);
    expect(doc.turns).toHaveLength(1);
    expect(doc.turns[0]!.blocks[0]).toEqual({
      kind: 'agent_message',
      messageId: 'm1',
      parts: [{ type: 'text', text: 'ab' }],
    });
  });

  it('appends an image chunk as an atomic part, then opens a new text part', () => {
    const doc = fold([textChunk('m1', '看这个：'), imageChunk('m1'), textChunk('m1', '如上。')]);
    expect(doc.turns[0]!.blocks[0]).toEqual({
      kind: 'agent_message',
      messageId: 'm1',
      parts: [
        { type: 'text', text: '看这个：' },
        IMAGE,
        { type: 'text', text: '如上。' },
      ],
    });
  });

  it('keeps consecutive images as separate parts', () => {
    const doc = fold([imageChunk('m1'), imageChunk('m1')]);
    expect(doc.turns[0]!.blocks[0]).toEqual({
      kind: 'agent_message',
      messageId: 'm1',
      parts: [IMAGE, IMAGE],
    });
  });

  it('opens a new block on a messageId mismatch', () => {
    const doc = fold([textChunk('m1', 'first'), textChunk('m2', 'second')]);
    const blocks = doc.turns[0]!.blocks;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: 'agent_message', messageId: 'm1' });
    expect(blocks[1]).toMatchObject({ kind: 'agent_message', messageId: 'm2' });
  });

  it('continues the last open block when messageId is absent (v1 optional id)', () => {
    const doc = fold([textChunk('m1', 'first'), textChunk(undefined, 'more')]);
    expect(doc.turns[0]!.blocks).toHaveLength(1);
    expect(doc.turns[0]!.blocks[0]).toMatchObject({
      parts: [{ type: 'text', text: 'firstmore' }],
    });
  });

  it('opens a new assistant block after a later user turn when live chunks omit messageId', () => {
    const doc = fold([
      { sessionUpdate: 'user_message', content: [{ type: 'text', text: '你好' }] },
      textChunk(undefined, '你好！'),
      { sessionUpdate: 'user_message', content: [{ type: 'text', text: '你会哪些工具调用？' }] },
      textChunk(undefined, '我可以调用 ls、read_file 等工具。'),
    ]);

    expect(doc.turns).toHaveLength(2);
    expect(doc.turns[0]!.blocks).toEqual([
      { kind: 'user_message', content: [{ type: 'text', text: '你好' }] },
      {
        kind: 'agent_message',
        messageId: 'msg-2',
        parts: [{ type: 'text', text: '你好！' }],
      },
    ]);
    expect(doc.turns[1]!.blocks).toEqual([
      { kind: 'user_message', content: [{ type: 'text', text: '你会哪些工具调用？' }] },
      {
        kind: 'agent_message',
        messageId: 'msg-4',
        parts: [{ type: 'text', text: '我可以调用 ls、read_file 等工具。' }],
      },
    ]);
  });

  it('preserves mixed content in user_message blocks', () => {
    const doc = fold([
      {
        sessionUpdate: 'user_message',
        content: [{ type: 'text', text: '截图如下' }, IMAGE],
      },
    ]);
    expect(doc.turns[0]!.blocks[0]).toEqual({
      kind: 'user_message',
      content: [{ type: 'text', text: '截图如下' }, IMAGE],
    });
  });

  it('merges adjacent replayed user_message chunks into one multipart turn', () => {
    const doc = fold([
      { sessionUpdate: 'user_message', content: [IMAGE] },
      { sessionUpdate: 'user_message', content: [{ type: 'text', text: '截图如下' }] },
      textChunk('reply', '看到了'),
      { sessionUpdate: 'user_message', content: [{ type: 'text', text: '下一轮' }] },
    ]);

    expect(doc.turns).toHaveLength(2);
    expect(doc.turns[0]!.blocks[0]).toEqual({
      kind: 'user_message',
      content: [IMAGE, { type: 'text', text: '截图如下' }],
    });
    expect(doc.turns[1]!.blocks[0]).toEqual({
      kind: 'user_message',
      content: [{ type: 'text', text: '下一轮' }],
    });
  });

  it('streams thought chunks through the same parts model', () => {
    const doc = fold([
      {
        sessionUpdate: 'agent_thought_chunk',
        messageId: 't1',
        content: { type: 'text', text: '先想想' },
      },
      {
        sessionUpdate: 'agent_thought_chunk',
        messageId: 't1',
        content: IMAGE,
      },
    ]);
    expect(doc.turns[0]!.blocks[0]).toEqual({
      kind: 'thought',
      messageId: 't1',
      parts: [{ type: 'text', text: '先想想' }, IMAGE],
    });
  });
});

describe('reducer raw notification ownership', () => {
  it('accumulates raw notifications on the block chunks fold into', () => {
    const r1 = rawNote('r1');
    const r2 = rawNote('r2');
    const doc = fold([
      carryingRaw(textChunk('m1', 'a'), r1),
      carryingRaw(textChunk('m1', 'b'), r2),
    ]);
    expect(doc.turns[0]!.blocks[0]).toMatchObject({
      kind: 'agent_message',
      rawNotifications: [r1, r2],
    });
  });

  it('attributes a raw notification to a merged user message', () => {
    const r = rawNote('u');
    const doc = fold([
      { sessionUpdate: 'user_message', content: [{ type: 'text', text: 'a' }] },
      carryingRaw({ sessionUpdate: 'user_message', content: [{ type: 'text', text: 'b' }] }, r),
    ]);
    expect(doc.turns[0]!.blocks[0]).toMatchObject({
      kind: 'user_message',
      rawNotifications: [r],
    });
  });

  it('accumulates raw notifications on tool calls across create and updates', () => {
    const r1 = rawNote('t-create');
    const r2 = rawNote('t-update');
    const doc = fold([
      // Tool calls and plans attach to the current turn; open one first.
      { sessionUpdate: 'user_message', content: [{ type: 'text', text: 'go' }] },
      carryingRaw(
        { sessionUpdate: 'tool_call', toolCallId: 't-1', title: 'Read', kind: 'read' },
        r1,
      ),
      carryingRaw(
        { sessionUpdate: 'tool_call_update', toolCallId: 't-1', status: 'completed' },
        r2,
      ),
      { sessionUpdate: 'tool_call_update', toolCallId: 't-1', title: 'Read (renamed)' },
      { sessionUpdate: 'tool_call_update', toolCallId: 't-1', rawOutput: { exitCode: 0 } },
    ]);
    const turn = doc.turns[0]!;
    const call = (turn.blocks[1] as { call: { rawNotifications?: unknown[]; title: string; rawOutput?: unknown } }).call;
    expect(call.rawNotifications).toEqual([r1, r2]);
    expect(call.title).toBe('Read (renamed)');
    // rawOutput merges last-write-wins and survives later updates without it.
    expect(call.rawOutput).toEqual({ exitCode: 0 });
  });

  it('leaves block shapes untouched when events carry no raw', () => {
    const doc = fold([textChunk('m1', 'a')]);
    expect(doc.turns[0]!.blocks[0]).toEqual({
      kind: 'agent_message',
      messageId: 'm1',
      parts: [{ type: 'text', text: 'a' }],
    });
  });
});

describe('reducer session-level latest notifications', () => {
  it('records usage and plan notifications as the latest of their kind', () => {
    const ru = rawNote('u1');
    const rp = rawNote('p1');
    const doc = fold([
      { sessionUpdate: 'user_message', content: [{ type: 'text', text: 'go' }] },
      carryingRaw(
        {
          sessionUpdate: 'usage_update',
          used: 10,
          size: 100,
          cost: { amount: 0.1, currency: 'USD' },
        },
        ru,
      ),
      carryingRaw({ sessionUpdate: 'plan', entries: [] }, rp),
    ]);
    expect(doc.usage).toEqual({ used: 10, size: 100, cost: { amount: 0.1, currency: 'USD' } });
    expect(doc.latestNotifications.usage_update).toBe(ru);
    expect(doc.latestNotifications.plan).toBe(rp);
  });

  it('keeps only the newest notification per session-level kind', () => {
    const r1 = rawNote('mode-1');
    const r2 = rawNote('mode-2');
    const doc = fold([
      { sessionUpdate: 'session_state', kind: 'current_mode_update', raw: r1 },
      { sessionUpdate: 'session_state', kind: 'current_mode_update', raw: r2 },
      { sessionUpdate: 'session_state', kind: 'compaction_update', raw: r1 },
    ]);
    expect(doc.latestNotifications.current_mode_update).toBe(r2);
    expect(doc.latestNotifications.compaction_update).toBe(r1);
    expect(doc.turns).toHaveLength(0); // session_state never opens a turn
  });
});

describe('reducer unsupported events', () => {
  const unsupported = (raw: SessionNotification): AcpSessionUpdate => ({
    sessionUpdate: 'unsupported',
    raw,
  });

  it('appends an unsupported block in flow order and buckets the notification', () => {
    const r = rawNote('vendor-x');
    const doc = fold([
      textChunk('m1', 'answer'),
      unsupported(r),
      textChunk('m1', ' continues'),
    ]);
    const blocks = doc.turns[0]!.blocks;
    expect(blocks.map((b) => b.kind)).toEqual(['agent_message', 'unsupported', 'agent_message']);
    expect(blocks[1]).toEqual({ kind: 'unsupported', notification: r });
    expect(doc.unhandledNotifications).toEqual([r]);
  });

  it('creates a turn when an unsupported event arrives before any content', () => {
    const r = rawNote('early-vendor');
    const doc = fold([unsupported(r)]);
    expect(doc.turns).toHaveLength(1);
    expect(doc.turns[0]!.blocks).toEqual([{ kind: 'unsupported', notification: r }]);
    expect(doc.unhandledNotifications).toEqual([r]);
  });

  it('folds deterministically: same events, same document', () => {
    const r = rawNote('determinism');
    const events = [
      textChunk('m1', 'a'),
      carryingRaw(textChunk('m1', 'b'), r),
      unsupported(rawNote('later')),
    ];
    expect(fold(events)).toEqual(fold([...events]));
  });
});

describe('reducer echo reconciliation (optimistic user messages)', () => {
  it('marks the optimistic echo block and keeps it distinguishable', () => {
    const doc = fold([{ sessionUpdate: 'user_message', content: [{ type: 'text', text: 'hi' }], optimistic: true }]);
    expect(doc.turns[0]!.blocks[0]).toEqual({
      kind: 'user_message',
      content: [{ type: 'text', text: 'hi' }],
      optimistic: true,
    });
  });

  it('never merges protocol user messages into an optimistic block', () => {
    const doc = fold([
      { sessionUpdate: 'user_message', content: [{ type: 'text', text: 'hi' }], optimistic: true },
      { sessionUpdate: 'user_message', content: [{ type: 'text', text: '别的' }] },
    ]);
    expect(doc.turns).toHaveLength(1); // flushed echo stays in the same turn
    expect(doc.turns[0]!.blocks.map((b) => (b.kind === 'user_message' ? b.content : null))).toEqual([
      [{ type: 'text', text: 'hi' }],
      [{ type: 'text', text: '别的' }],
    ]);
  });

  it('still merges adjacent plain user chunks (replay multipart echo)', () => {
    const doc = fold([
      { sessionUpdate: 'user_message', content: [{ type: 'text', text: 'a' }] },
      { sessionUpdate: 'user_message', content: [{ type: 'text', text: 'b' }] },
    ]);
    expect(doc.turns[0]!.blocks).toHaveLength(1);
    expect(doc.turns[0]!.blocks[0]).toMatchObject({
      kind: 'user_message',
      content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
    });
  });

  it('confirms the optimistic block: protocolMessageId + echo attribution, flag cleared', () => {
    const r = rawNote('echo');
    const doc = fold([
      { sessionUpdate: 'user_message', content: [{ type: 'text', text: 'hi' }], optimistic: true },
      { sessionUpdate: 'user_message_confirmed', protocolMessageId: 'pm-1', notifications: [r] },
    ]);
    expect(doc.turns[0]!.blocks[0]).toEqual({
      kind: 'user_message',
      content: [{ type: 'text', text: 'hi' }],
      protocolMessageId: 'pm-1',
      rawNotifications: [r],
    });
    // Confirmed blocks no longer absorb adjacent user chunks either.
    const after = applyUpdate(doc, { sessionUpdate: 'user_message', content: [{ type: 'text', text: 'late' }] });
    expect(after.turns[0]!.blocks).toHaveLength(2);
  });

  it('ignores a confirmation without a trailing optimistic block, loudly', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const doc = fold([{ sessionUpdate: 'user_message', content: [{ type: 'text', text: 'hi' }] }]);
    const confirmed = applyUpdate(doc, { sessionUpdate: 'user_message_confirmed', notifications: [] });
    expect(confirmed).toBe(doc);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('user_message_confirmed'));
    warnSpy.mockRestore();
  });
});

  it('keeps the optimistic marker (and the merge lock) when the echo carried no messageId', () => {
    const r = rawNote('echo-no-id');
    const doc = fold([
      { sessionUpdate: 'user_message', content: [{ type: 'text', text: 'hi' }], optimistic: true },
      { sessionUpdate: 'user_message_confirmed', notifications: [r] },
    ]);
    expect(doc.turns[0]!.blocks[0]).toEqual({
      kind: 'user_message',
      content: [{ type: 'text', text: 'hi' }],
      optimistic: true,
      rawNotifications: [r],
    });
    const after = applyUpdate(doc, { sessionUpdate: 'user_message', content: [{ type: 'text', text: 'late' }] });
    expect(after.turns[0]!.blocks).toHaveLength(2);
  });

describe('reducer permission lifecycle (issue #18)', () => {
  const request = (toolCallId: string, title = `操作 ${toolCallId}`) => ({
    toolCallId,
    title,
    kind: 'edit' as const,
    options: [{ id: 'o-1', name: 'Allow once', kind: 'allow_once' as const }],
  });

  it('records concurrent pending permissions independently', () => {
    const doc = fold([
      { sessionUpdate: 'user_message', content: [{ type: 'text', text: 'go' }] },
      { sessionUpdate: 'permission_requested', request: request('t-1') },
      { sessionUpdate: 'permission_requested', request: request('t-2') },
    ]);
    expect(doc.permissions['t-1']).toMatchObject({ status: 'pending', response: null });
    expect(doc.permissions['t-2']).toMatchObject({ status: 'pending', response: null });
  });

  it('settles one permission without touching the others and keeps the record', () => {
    const doc = fold([
      { sessionUpdate: 'user_message', content: [{ type: 'text', text: 'go' }] },
      { sessionUpdate: 'permission_requested', request: request('t-1') },
      { sessionUpdate: 'permission_requested', request: request('t-2') },
      { sessionUpdate: 'permission_resolved', toolCallId: 't-1', response: { outcome: 'selected', kind: 'allow_once' } },
    ]);
    expect(doc.permissions['t-1']).toEqual({
      status: 'resolved',
      request: request('t-1'),
      response: { outcome: 'selected', kind: 'allow_once' },
    });
    expect(doc.permissions['t-2']).toMatchObject({ status: 'pending' });
  });

  it('denied-by-policy settles as resolved, retires the pending tool, and is not pending (issue #22)', () => {
    const doc = fold([
      { sessionUpdate: 'user_message', content: [{ type: 'text', text: 'go' }] },
      { sessionUpdate: 'permission_requested', request: request('t-policy') },
      { sessionUpdate: 'permission_resolved', toolCallId: 't-policy', response: { outcome: 'denied-by-policy', kind: 'reject_once' } },
    ]);
    expect(doc.permissions['t-policy']).toEqual({
      status: 'resolved',
      request: request('t-policy'),
      response: { outcome: 'denied-by-policy', kind: 'reject_once' },
    });
    // The placeholder tool the request planted must retire — the tool will
    // not run, exactly like a user reject.
    expect(doc.turns[0]!.blocks).toContainEqual(
      expect.objectContaining({
        kind: 'tool_call',
        call: expect.objectContaining({ id: 't-policy', status: 'cancelled' }),
      }),
    );
    // 不再点亮「需要关注」：policy 拒绝是终态，不是挂起。
    expect(Object.values(doc.permissions).some((permission) => permission.status === 'pending')).toBe(false);
  });

  it('plants a placeholder tool record when the permission precedes its tool_call, then merges', () => {
    const before = fold([
      { sessionUpdate: 'user_message', content: [{ type: 'text', text: 'go' }] },
      { sessionUpdate: 'permission_requested', request: request('t-out-of-order') },
    ]);
    // Placeholder visible immediately, carrying the request's title/kind.
    expect(before.turns[0]!.blocks).toContainEqual(
      expect.objectContaining({
        kind: 'tool_call',
        call: expect.objectContaining({ id: 't-out-of-order', title: '操作 t-out-of-order', kind: 'edit', status: 'pending' }),
      }),
    );

    const merged = applyUpdate(before, {
      sessionUpdate: 'tool_call',
      toolCallId: 't-out-of-order',
      title: 'Edit file: src/a.ts',
      kind: 'edit',
      status: 'in_progress',
    });
    // The later tool_call merges into the placeholder — no duplicate block.
    const calls = merged.turns[0]!.blocks.filter((b) => b.kind === 'tool_call');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ call: { id: 't-out-of-order', title: 'Edit file: src/a.ts', status: 'in_progress' } });
  });

  it('keeps a cancelled permission as cancelled (turn cancel / disconnect)', () => {
    const doc = fold([
      { sessionUpdate: 'user_message', content: [{ type: 'text', text: 'go' }] },
      { sessionUpdate: 'permission_requested', request: request('t-1') },
      { sessionUpdate: 'permission_resolved', toolCallId: 't-1', response: { outcome: 'cancelled' } },
    ]);
    expect(doc.permissions['t-1']).toMatchObject({
      status: 'cancelled',
      response: { outcome: 'cancelled' },
    });
  });

  it('drops a resolve for an unknown toolCallId loudly', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const doc = fold([
      { sessionUpdate: 'user_message', content: [{ type: 'text', text: 'go' }] },
      { sessionUpdate: 'permission_resolved', toolCallId: 'ghost', response: { outcome: 'cancelled' } },
    ]);
    expect(doc.permissions).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('permission_resolved for unknown toolCallId ghost'),
    );
    warnSpy.mockRestore();
  });

  it('retires a still-pending placeholder tool record when the tool will never run', () => {
    const base = fold([
      { sessionUpdate: 'user_message', content: [{ type: 'text', text: 'go' }] },
      { sessionUpdate: 'permission_requested', request: request('t-1') },
    ]);
    const cancelled = applyUpdate(base, {
      sessionUpdate: 'permission_resolved',
      toolCallId: 't-1',
      response: { outcome: 'cancelled' },
    });
    expect(cancelled.turns[0]!.blocks).toContainEqual(
      expect.objectContaining({ kind: 'tool_call', call: expect.objectContaining({ id: 't-1', status: 'cancelled' }) }),
    );

    const rejected = applyUpdate(base, {
      sessionUpdate: 'permission_resolved',
      toolCallId: 't-1',
      response: { outcome: 'selected', kind: 'reject_once' },
    });
    expect(rejected.turns[0]!.blocks).toContainEqual(
      expect.objectContaining({ kind: 'tool_call', call: expect.objectContaining({ id: 't-1', status: 'cancelled' }) }),
    );
  });

  it('keeps the placeholder pending on allow, and never retires a call that already started', () => {
    const base = fold([
      { sessionUpdate: 'user_message', content: [{ type: 'text', text: 'go' }] },
      { sessionUpdate: 'permission_requested', request: request('t-1') },
    ]);
    const allowed = applyUpdate(base, {
      sessionUpdate: 'permission_resolved',
      toolCallId: 't-1',
      response: { outcome: 'selected', kind: 'allow_once' },
    });
    expect(allowed.turns[0]!.blocks).toContainEqual(
      expect.objectContaining({ kind: 'tool_call', call: expect.objectContaining({ id: 't-1', status: 'pending' }) }),
    );

    const started = applyUpdate(base, { sessionUpdate: 'tool_call', toolCallId: 't-1', title: 'Edit', kind: 'edit', status: 'in_progress' });
    const settled = applyUpdate(started, {
      sessionUpdate: 'permission_resolved',
      toolCallId: 't-1',
      response: { outcome: 'cancelled' },
    });
    expect(settled.turns[0]!.blocks).toContainEqual(
      expect.objectContaining({ kind: 'tool_call', call: expect.objectContaining({ id: 't-1', status: 'in_progress' }) }),
    );
  });

  it('folds a re-asked permission back to pending (requested after resolved)', () => {
    const doc = fold([
      { sessionUpdate: 'user_message', content: [{ type: 'text', text: 'go' }] },
      { sessionUpdate: 'permission_requested', request: request('t-1') },
      { sessionUpdate: 'permission_resolved', toolCallId: 't-1', response: { outcome: 'cancelled' } },
      { sessionUpdate: 'permission_requested', request: request('t-1', '重新请求') },
    ]);
    expect(doc.permissions['t-1']).toMatchObject({
      status: 'pending',
      request: request('t-1', '重新请求'),
      response: null,
    });
  });
});
