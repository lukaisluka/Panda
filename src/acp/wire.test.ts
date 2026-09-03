import { describe, expect, it, vi } from 'vitest';
import { client } from '@agentclientprotocol/sdk';
import type { SessionNotification, SessionUpdate } from '@agentclientprotocol/sdk';
import {
  parseSessionNotification,
  removeSdkStrictSessionUpdateRouter,
  toAcpUpdates,
} from './wire';

/** Loose constructor: unknown-kind payloads need to bypass the SDK's closed union. */
const note = (update: object, sessionId = 's-1'): SessionNotification =>
  ({ sessionId, update }) as unknown as SessionNotification;

describe('toAcpUpdates raw preservation', () => {
  it('maps known in-flow kinds with the raw notification attached', () => {
    const n = note({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm-1',
      content: { type: 'text', text: '你好' },
    } satisfies SessionUpdate);
    expect(toAcpUpdates(n)).toEqual([
      {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm-1',
        content: { type: 'text', text: '你好' },
        raw: n,
      },
    ]);
  });

  it('turns a chunk whose only content block is unsupported into an unsupported event', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const n = note({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'audio', data: 'AQID', mimeType: 'audio/wav' },
    } as object);
    expect(toAcpUpdates(n)).toEqual([{ sessionUpdate: 'unsupported', raw: n }]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('audio'));
    warnSpy.mockRestore();
  });

  it('keeps tool calls with unsupported-only content on the create event only', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const n = note({
      sessionUpdate: 'tool_call',
      toolCallId: 't-1',
      title: 'Run tests',
      content: [{ type: 'terminal', stream: 'stdout', text: 'ok' }],
    } as object);
    const events = toAcpUpdates(n);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ sessionUpdate: 'tool_call', toolCallId: 't-1' });
    expect(events[0]!.raw).toBe(n); // terminal payload stays reachable via raw
    expect(events[1]).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't-1',
      content: [],
    });
    expect('raw' in events[1]!).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('terminal'));
    warnSpy.mockRestore();
  });

  it('records recognized session-level kinds as session_state with the raw notification', () => {
    for (const update of [
      { sessionUpdate: 'current_mode_update', currentModeId: 'code' },
      { sessionUpdate: 'config_option_update', configOptions: [] },
      { sessionUpdate: 'session_info_update', title: 't' },
      { sessionUpdate: 'compaction_update' },
    ] as object[]) {
      const n = note(update);
      expect(toAcpUpdates(n)).toEqual([
        { sessionUpdate: 'session_state', kind: (update as SessionUpdate).sessionUpdate, raw: n },
      ]);
    }
  });

  it('preserves unknown sessionUpdate kinds as unsupported events instead of dropping them', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const n = note({ sessionUpdate: 'vendor_extension', payload: { x: 1 } });
    expect(toAcpUpdates(n)).toEqual([{ sessionUpdate: 'unsupported', raw: n }]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('vendor_extension'));
    warnSpy.mockRestore();
  });

  it('attaches raw to plan and usage updates', () => {
    const plan = note({ sessionUpdate: 'plan', entries: [] } satisfies SessionUpdate);
    expect(toAcpUpdates(plan)).toEqual([{ sessionUpdate: 'plan', entries: [], raw: plan }]);

    const usage = note({
      sessionUpdate: 'usage_update',
      used: 1,
      size: 2,
    } satisfies SessionUpdate);
    expect(toAcpUpdates(usage)).toEqual([
      { sessionUpdate: 'usage_update', used: 1, size: 2, cost: undefined, raw: usage },
    ]);
  });
});

describe('parseSessionNotification', () => {
  it('passes structurally sound notifications through unvalidated', () => {
    const params = {
      sessionId: 's-1',
      update: { sessionUpdate: 'vendor_extension', payload: { x: 1 } },
    };
    expect(parseSessionNotification(params)).toBe(params);
  });

  it('throws loudly on structurally broken params', () => {
    expect(() => parseSessionNotification(null)).toThrow(/session\/update/);
    expect(() => parseSessionNotification({ update: { sessionUpdate: 'x' } })).toThrow(/sessionId/);
    expect(() => parseSessionNotification({ sessionId: 's-1', update: null })).toThrow(
      /sessionUpdate/,
    );
    expect(() => parseSessionNotification({ sessionId: 's-1', update: {} })).toThrow(
      /sessionUpdate/,
    );
  });
});

describe('removeSdkStrictSessionUpdateRouter', () => {
  it('removes exactly the router handler from a real ClientApp builder', () => {
    const app = client({ name: 'panda' });
    const { builder } = app as unknown as {
      builder: { handlers: { describe?: () => string }[] };
    };
    const before = builder.handlers.length;
    removeSdkStrictSessionUpdateRouter(app);
    expect(builder.handlers).toHaveLength(before - 1);
    expect(builder.handlers.map((h) => h.describe?.())).not.toContain(
      'client-session-update-router',
    );
  });

  it('reports loudly when the private builder shape changes (no-op removal)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    removeSdkStrictSessionUpdateRouter(
      { builder: { handlers: [] } } as unknown as Parameters<typeof removeSdkStrictSessionUpdateRouter>[0],
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('严格校验 router'));
    errorSpy.mockRestore();
  });
});
