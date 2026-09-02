import { describe, expect, it } from 'vitest';
import { applyUpdate, emptySession } from './reducer';
import type { AcpSessionUpdate, SessionDocument } from './types';

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
