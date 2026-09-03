import { describe, expect, it } from 'vitest';
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

const withRaw = (update: AcpSessionUpdate, raw: SessionNotification): AcpSessionUpdate => ({
  ...update,
  raw,
});

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
      withRaw(textChunk('m1', 'a'), r1),
      withRaw(textChunk('m1', 'b'), r2),
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
      withRaw({ sessionUpdate: 'user_message', content: [{ type: 'text', text: 'b' }] }, r),
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
      withRaw(
        { sessionUpdate: 'tool_call', toolCallId: 't-1', title: 'Read', kind: 'read' },
        r1,
      ),
      withRaw(
        { sessionUpdate: 'tool_call_update', toolCallId: 't-1', status: 'completed' },
        r2,
      ),
      { sessionUpdate: 'tool_call_update', toolCallId: 't-1', title: 'Read (renamed)' },
    ]);
    const turn = doc.turns[0]!;
    const call = (turn.blocks[1] as { call: { rawNotifications?: unknown[]; title: string } }).call;
    expect(call.rawNotifications).toEqual([r1, r2]);
    expect(call.title).toBe('Read (renamed)');
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
      withRaw(
        {
          sessionUpdate: 'usage_update',
          used: 10,
          size: 100,
          cost: { amount: 0.1, currency: 'USD' },
        },
        ru,
      ),
      withRaw({ sessionUpdate: 'plan', entries: [] }, rp),
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
      withRaw(textChunk('m1', 'b'), r),
      unsupported(rawNote('later')),
    ];
    expect(fold(events)).toEqual(fold([...events]));
  });
});
