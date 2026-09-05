import { describe, expect, it, vi } from 'vitest';
import type { ContentBlock, SessionNotification } from '@agentclientprotocol/sdk';
import { EchoReconciler, echoRelation } from './echoReconciliation';
import { toAcpUpdates } from './wire';

/** Loose constructor: unknown-kind payloads need to bypass the SDK's closed union. */
const note = (update: object, sessionId = 's-1'): SessionNotification =>
  ({ sessionId, update }) as unknown as SessionNotification;

const text = (t: string) => ({ type: 'text' as const, text: t });

const echoChunk = (t: string, messageId?: string): SessionNotification =>
  messageId
    ? note({ sessionUpdate: 'user_message_chunk', content: text(t), messageId })
    : note({ sessionUpdate: 'user_message_chunk', content: text(t) });

const agentChunk = (t: string): SessionNotification =>
  note({ sessionUpdate: 'agent_message_chunk', content: text(t) });

describe('echoRelation (sent prompt vs agent echo)', () => {
  it('equal for verbatim text echo, including segmented chunks', () => {
    expect(echoRelation([text('hello world')], [text('hello world')])).toBe('equal');
    expect(echoRelation([text('hello world')], [text('hello '), text('world')])).toBe('equal');
  });

  it('prefix while the echo is still streaming', () => {
    expect(echoRelation([text('hello')], [text('hel')])).toBe('prefix');
  });

  it('different for divergent text or extra blocks', () => {
    expect(echoRelation([text('hi')], [text('别的')])).toBe('different');
    expect(echoRelation([text('hi')], [text('hi'), text('again')])).toBe('different');
  });

  it('compares non-text content structurally, ignoring key order', () => {
    const sent = [{ type: 'image' as const, data: 'aGk=', mimeType: 'image/png' }];
    // Wire JSON arrives with agent-chosen key order; must still match.
    const echoed = [
      { mimeType: 'image/png', data: 'aGk=', type: 'resource' } as unknown as ContentBlock,
      { data: 'aGk=', mimeType: 'image/png', type: 'image' } as unknown as ContentBlock,
    ];
    expect(echoRelation(sent, echoed.slice(1))).toBe('equal');
    expect(
      echoRelation(sent, [
        { data: 'aGk=', mimeType: 'image/webp', type: 'image' } as unknown as ContentBlock,
      ]),
    ).toBe('different');
  });

  it('treats an echo containing unmappable content as different', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      echoRelation([text('hi')], [
        { type: 'audio', data: 'AQID', mimeType: 'audio/wav' } as unknown as ContentBlock,
      ]),
    ).toBe('different');
    warnSpy.mockRestore();
  });
});

describe('EchoReconciler (echo window state machine)', () => {
  it('holds a prefix, then confirms on equal and closes the window', () => {
    const r = new EchoReconciler([text('hello world')]);
    expect(r.feed(echoChunk('hello '))).toEqual({ consumed: true, events: [] });

    const last = echoChunk('world');
    const confirmed = r.feed(last);
    expect(confirmed.consumed).toBe(true);
    expect(confirmed.events).toEqual([
      {
        sessionUpdate: 'user_message_confirmed',
        protocolMessageId: undefined,
        notifications: [echoChunk('hello '), last],
      },
    ]);

    // Window closed: later chunks pass through untouched.
    expect(r.feed(echoChunk('again'))).toEqual({ consumed: false, events: [] });
    expect(r.settle()).toEqual([]);
  });

  it('carries the protocol messageId onto the confirmation event', () => {
    const r = new EchoReconciler([text('hi')]);
    r.feed(echoChunk('h', 'm-1'));
    const confirmed = r.feed(echoChunk('i', 'm-1'));
    expect(confirmed.events[0]).toMatchObject({
      sessionUpdate: 'user_message_confirmed',
      protocolMessageId: 'm-1',
    });
  });

  it('flushes the buffered echo as real events when the echo diverges', () => {
    const r = new EchoReconciler([text('planned')]);
    r.feed(echoChunk('plan'));
    const diverged = echoChunk('B');
    const flush = r.feed(diverged);
    expect(flush.consumed).toBe(true);
    expect(flush.events).toEqual([...toAcpUpdates(echoChunk('plan')), ...toAcpUpdates(diverged)]);
    expect(r.settle()).toEqual([]);
  });

  it('closes the window on a non-echo update, flushing any partial echo before it', () => {
    const r = new EchoReconciler([text('planned')]);
    r.feed(echoChunk('plan'));
    const boundary = agentChunk('agent speaking');
    const flush = r.feed(boundary);
    expect(flush.consumed).toBe(false); // the boundary update itself passes through
    expect(flush.events).toEqual(toAcpUpdates(echoChunk('plan')));
  });

  it('passes a non-echo update through untouched when nothing is buffered', () => {
    const r = new EchoReconciler([text('planned')]);
    expect(r.feed(agentChunk('first'))).toEqual({ consumed: false, events: [] });
  });

  it('flushes when a second protocol message starts echoing (messageId change)', () => {
    const r = new EchoReconciler([text('hello')]);
    r.feed(echoChunk('he', 'm-1'));
    const second = echoChunk('x', 'm-2');
    const flush = r.feed(second);
    expect(flush.consumed).toBe(false); // the new chunk passes through as-is
    expect(flush.events).toEqual(toAcpUpdates(echoChunk('he', 'm-1')));
  });

  it('settle flushes a prefix that never completed (renders the protocol version)', () => {
    const r = new EchoReconciler([text('hello')]);
    r.feed(echoChunk('hel'));
    expect(r.settle()).toEqual(toAcpUpdates(echoChunk('hel')));
  });

  it('settle with an empty buffer emits nothing', () => {
    const r = new EchoReconciler([text('hello')]);
    expect(r.settle()).toEqual([]);
  });
});
