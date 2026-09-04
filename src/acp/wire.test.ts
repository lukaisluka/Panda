import { describe, expect, it, vi } from 'vitest';
import { client } from '@agentclientprotocol/sdk';
import type { ContentBlock, SessionNotification, SessionUpdate } from '@agentclientprotocol/sdk';
import {
  echoRelation,
  parseSessionNotification,
  removeSdkStrictSessionUpdateRouter,
  toAcpUpdates,
  toElicitationRequest,
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
    const audio = note({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'audio', data: 'AQID', mimeType: 'audio/wav' },
    } as object);
    expect(toAcpUpdates(audio)).toEqual([{ sessionUpdate: 'unsupported', raw: audio }]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('audio'));
    const resource = note({
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'resource',
        resource: { uri: 'file:///tmp/x.txt', mimeType: 'text/plain', text: 'x' },
      },
    } as object);
    expect(toAcpUpdates(resource)).toEqual([{ sessionUpdate: 'unsupported', raw: resource }]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('resource'));
    warnSpy.mockRestore();
  });

  it('maps unsupported tool content (terminal) to an explicit unsupported entry', () => {
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
    expect((events[0] as { raw?: SessionNotification }).raw).toBe(n); // terminal payload stays reachable via raw
    // Not dropped: the follow-up update carries an explicit unsupported row
    // the stream can render, instead of a silent empty content list.
    expect(events[1]).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't-1',
      content: [{ type: 'unsupported', blockType: 'terminal' }],
    });
    expect('raw' in (events[1] as object)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('terminal'));
    warnSpy.mockRestore();
  });

  it('maps unsupported content blocks (audio) inside tool content to unsupported entries', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const n = note({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't-2',
      content: [
        { type: 'content', content: { type: 'text', text: 'done' } },
        { type: 'content', content: { type: 'audio', data: 'AQID', mimeType: 'audio/wav' } },
      ],
    } as object);
    expect(toAcpUpdates(n)).toEqual([
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't-2',
        title: undefined,
        status: undefined,
        content: [
          { type: 'content', content: { type: 'text', text: 'done' } },
          { type: 'unsupported', blockType: 'audio' },
        ],
        locations: undefined,
        rawOutput: undefined,
        raw: n,
      },
    ]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('audio'));
    warnSpy.mockRestore();
  });

  it('passes tool rawOutput through and drops non-object values loudly', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ok = note({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't-3',
      rawOutput: { exitCode: 0, stdout: 'ok' },
    } as object);
    expect(toAcpUpdates(ok)).toMatchObject([
      { sessionUpdate: 'tool_call_update', toolCallId: 't-3', rawOutput: { exitCode: 0, stdout: 'ok' } },
    ]);

    const bad = note({ sessionUpdate: 'tool_call_update', toolCallId: 't-4', rawOutput: 'oops' } as object);
    expect(toAcpUpdates(bad)).toMatchObject([{ sessionUpdate: 'tool_call_update', toolCallId: 't-4', rawOutput: undefined }]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('rawOutput'));
    warnSpy.mockRestore();
  });

  it('records recognized session-level kinds as session_state with the raw notification', () => {
    for (const update of [
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

  it('maps current_mode_update to a mode_changed event (wire field is currentModeId)', () => {
    const n = note({ sessionUpdate: 'current_mode_update', currentModeId: 'code' });
    expect(toAcpUpdates(n)).toEqual([{ sessionUpdate: 'mode_changed', modeId: 'code', raw: n }]);
  });

  it('keeps a malformed current_mode_update as unsupported, loudly', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const n = note({ sessionUpdate: 'current_mode_update' });
    expect(toAcpUpdates(n)).toEqual([{ sessionUpdate: 'unsupported', raw: n }]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('current_mode_update'));
    warnSpy.mockRestore();
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
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('strict session/update router'));
    errorSpy.mockRestore();
  });
});

  it('reports loudly when the builder is missing entirely (no crash)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    removeSdkStrictSessionUpdateRouter({} as Parameters<typeof removeSdkStrictSessionUpdateRouter>[0]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('strict session/update router'));
    errorSpy.mockRestore();
  });

describe('echoRelation (sent prompt vs agent echo)', () => {
  const text = (t: string) => ({ type: 'text' as const, text: t });

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

describe('toElicitationRequest (form mode whitelisting)', () => {
  it('maps every known property type to its field variant, honoring required and defaults', () => {
    const params = {
      sessionId: 's-1',
      mode: 'form',
      message: '补充信息',
      requestedSchema: {
        type: 'object',
        title: '重构选项',
        description: '动手前确认',
        required: ['tag', 'priority'],
        properties: {
          tag: { type: 'string', title: 'Tag' },
          strategy: {
            type: 'string',
            title: '策略',
            default: 'alias',
            oneOf: [
              { const: 'alias', title: '别名过渡' },
              { const: 'replace', title: '直接替换' },
            ],
          },
          priority: { type: 'integer', title: '优先级', default: 3 },
          notify: { type: 'boolean', title: '通知', default: true },
          scope: {
            type: 'array',
            title: '范围',
            default: ['tests'],
            items: {
              anyOf: [
                { const: 'tests', title: '测试' },
                { const: 'docs', title: '文档' },
              ],
            },
          },
        },
      },
    };
    expect(toElicitationRequest('elicit-1', params as never)).toEqual({
      id: 'elicit-1',
      toolCallId: null,
      title: '重构选项',
      description: '动手前确认',
      fields: [
        { key: 'tag', type: 'string', title: 'Tag', required: true, options: null },
        {
          key: 'strategy',
          type: 'string',
          title: '策略',
          required: false,
          options: [
            { value: 'alias', label: '别名过渡' },
            { value: 'replace', label: '直接替换' },
          ],
          default: 'alias',
        },
        { key: 'priority', type: 'integer', title: '优先级', required: true, default: 3 },
        { key: 'notify', type: 'boolean', title: '通知', required: false, default: true },
        {
          key: 'scope',
          type: 'multiselect',
          title: '范围',
          required: false,
          options: [
            { value: 'tests', label: '测试' },
            { value: 'docs', label: '文档' },
          ],
          default: ['tests'],
        },
      ],
    });
  });

  it('bare enum strings and bare enum multiselect items map to unlabeled options', () => {
    const params = {
      sessionId: 's-1',
      mode: 'form',
      message: '选',
      requestedSchema: {
        properties: {
          env: { type: 'string', enum: ['staging', 'prod'] },
          items: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
        },
      },
    };
    const mapped = toElicitationRequest('elicit-2', params as never);
    expect(mapped.fields[0]).toMatchObject({
      type: 'string',
      options: [
        { value: 'staging', label: 'staging' },
        { value: 'prod', label: 'prod' },
      ],
    });
    expect(mapped.fields[1]).toMatchObject({
      type: 'multiselect',
      options: [
        { value: 'a', label: 'a' },
        { value: 'b', label: 'b' },
      ],
    });
  });

  it('carries the session scope toolCallId when present, null when absent', () => {
    const schema = { properties: { tag: { type: 'string' } } };
    const withTool = { sessionId: 's-1', toolCallId: 't-9', mode: 'form', message: 'm', requestedSchema: schema };
    expect(toElicitationRequest('e', withTool as never).toolCallId).toBe('t-9');
    const noTool = { sessionId: 's-1', mode: 'form', message: 'm', requestedSchema: schema };
    expect(toElicitationRequest('e', noTool as never).toolCallId).toBe(null);
    const requestScoped = { requestId: 'r-1', mode: 'form', message: 'm', requestedSchema: schema };
    expect(toElicitationRequest('e', requestScoped as never).toolCallId).toBe(null);
  });

  it('an unknown property type becomes an inert unsupported field (warned, not dropped)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const params = {
      sessionId: 's-1',
      mode: 'form',
      message: 'm',
      requestedSchema: {
        properties: {
          custom: { type: '_vendorObject', title: '自定义' },
        },
      },
    };
    const mapped = toElicitationRequest('elicit-3', params as never);
    expect(mapped.fields).toEqual([
      { key: 'custom', type: 'unsupported', title: '自定义', required: false, propertyType: '_vendorObject' },
    ]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('custom'));
    warnSpy.mockRestore();
  });
});
