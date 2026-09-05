import { describe, expect, it, vi } from 'vitest';
import { client } from '@agentclientprotocol/sdk';
import type { SessionNotification, SessionUpdate } from '@agentclientprotocol/sdk';
import {
  parseSessionNotification,
  removeSdkStrictSessionUpdateRouter,
  toAcpUpdates,
  toConfigOptions,
  toAvailableCommands,
  toElicitationFormRequest,
  toElicitationUrlRequest,
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
    const update = { sessionUpdate: 'session_info_update', title: 't' } as object;
    const n = note(update);
    expect(toAcpUpdates(n)).toEqual([
      { sessionUpdate: 'session_state', kind: (update as SessionUpdate).sessionUpdate, raw: n },
    ]);
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

  it('maps a plan_update items variant onto the plan event (full replacement)', () => {
    const n = note({
      sessionUpdate: 'plan_update',
      plan: {
        type: 'items',
        planId: 'plan-1',
        entries: [{ content: 'step', priority: 'high', status: 'in_progress' }],
      },
    } as object);
    expect(toAcpUpdates(n)).toEqual([
      {
        sessionUpdate: 'plan',
        entries: [{ content: 'step', priority: 'high', status: 'in_progress' }],
        raw: n,
      },
    ]);
  });

  it('keeps plan_update file/markdown variants as unsupported, loudly', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = note({
      sessionUpdate: 'plan_update',
      plan: { type: 'file', planId: 'plan-2', uri: 'file:///plan.md' },
    } as object);
    expect(toAcpUpdates(file)).toEqual([{ sessionUpdate: 'unsupported', raw: file }]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('plan_update variant "file"'));
    warnSpy.mockRestore();
  });

  it('maps compaction_update with wire patch semantics verbatim', () => {
    const n = note({
      sessionUpdate: 'compaction_update',
      compactionId: 'c-1',
      status: 'in_progress',
    } as object);
    expect(toAcpUpdates(n)).toEqual([
      { sessionUpdate: 'compaction_update', compactionId: 'c-1', status: 'in_progress', raw: n },
    ]);

    const withSummary = note({
      sessionUpdate: 'compaction_update',
      compactionId: 'c-1',
      status: 'completed',
      summary: [{ type: 'text', text: 'summed up' }],
    } as object);
    expect(toAcpUpdates(withSummary)).toEqual([
      {
        sessionUpdate: 'compaction_update',
        compactionId: 'c-1',
        status: 'completed',
        summary: [{ type: 'text', text: 'summed up' }],
        raw: withSummary,
      },
    ]);
  });

  it('maps a compaction_summary_chunk onto the append event; unsupported content degrades loudly', () => {
    const n = note({
      sessionUpdate: 'compaction_summary_chunk',
      compactionId: 'c-1',
      content: { type: 'text', text: 'part' },
    } as object);
    expect(toAcpUpdates(n)).toEqual([
      {
        sessionUpdate: 'compaction_summary_chunk',
        compactionId: 'c-1',
        content: { type: 'text', text: 'part' },
        raw: n,
      },
    ]);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const audio = note({
      sessionUpdate: 'compaction_summary_chunk',
      compactionId: 'c-1',
      content: { type: 'audio', data: 'x', mimeType: 'audio/wav' },
    } as object);
    expect(toAcpUpdates(audio)).toEqual([{ sessionUpdate: 'unsupported', raw: audio }]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('compaction_summary_chunk'));
    warnSpy.mockRestore();
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

describe('toElicitationFormRequest (form mode whitelisting)', () => {
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
    expect(toElicitationFormRequest('elicit-1', params as never)).toEqual({
      mode: 'form',
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
    const mapped = toElicitationFormRequest('elicit-2', params as never);
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
    expect(toElicitationFormRequest('e', withTool as never).toolCallId).toBe('t-9');
    const noTool = { sessionId: 's-1', mode: 'form', message: 'm', requestedSchema: schema };
    expect(toElicitationFormRequest('e', noTool as never).toolCallId).toBe(null);
    const requestScoped = { requestId: 'r-1', mode: 'form', message: 'm', requestedSchema: schema };
    expect(toElicitationFormRequest('e', requestScoped as never).toolCallId).toBe(null);
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
    const mapped = toElicitationFormRequest('elicit-3', params as never);
    expect(mapped.fields).toEqual([
      { key: 'custom', type: 'unsupported', title: '自定义', required: false, propertyType: '_vendorObject' },
    ]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('custom'));
    warnSpy.mockRestore();
  });
});

describe('toElicitationUrlRequest (url mode whitelisting)', () => {
  it('maps message/url and keeps the wire elicitationId as the record id', () => {
    const params = {
      sessionId: 's-1',
      mode: 'url',
      message: '授权连接 GitHub',
      elicitationId: 'github-oauth-001',
      url: 'https://github.com/login/oauth/authorize?client_id=panda',
    };
    expect(toElicitationUrlRequest(params as never)).toEqual({
      mode: 'url',
      id: 'github-oauth-001', // unchanged — elicitation/complete matches on it
      toolCallId: null,
      message: '授权连接 GitHub',
      url: 'https://github.com/login/oauth/authorize?client_id=panda',
    });
  });

  it('carries the session scope toolCallId when present, null when absent', () => {
    const withTool = {
      sessionId: 's-1',
      toolCallId: 't-9',
      mode: 'url',
      message: 'm',
      elicitationId: 'e-1',
      url: 'https://example.com/a',
    };
    expect(toElicitationUrlRequest(withTool as never).toolCallId).toBe('t-9');
    const requestScoped = { requestId: 'r-1', mode: 'url', message: 'm', elicitationId: 'e-2', url: 'https://example.com/b' };
    expect(toElicitationUrlRequest(requestScoped as never).toolCallId).toBe(null);
  });
});

describe('toAvailableCommands (slash-command whitelisting)', () => {
  it('maps the full list: name, description, and input.hint', () => {
    const commands = toAvailableCommands({
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'status', description: '查看状态' },
        { name: 'tag', description: '打 tag', input: { hint: '版本号' } },
        { name: 'ci', description: '触发 CI', input: null },
      ],
    } as never);
    expect(commands).toEqual([
      { name: 'status', description: '查看状态', inputHint: null },
      { name: 'tag', description: '打 tag', inputHint: '版本号' },
      { name: 'ci', description: '触发 CI', inputHint: null },
    ]);
  });

  it('degrades a non-string input.hint to null instead of rejecting the command', () => {
    const commands = toAvailableCommands({
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'tag', description: 'd', input: { hint: 42 } }],
    } as never);
    expect(commands).toEqual([{ name: 'tag', description: 'd', inputHint: null }]);
  });

  it('rejects structural violations: non-array list, non-object entry, missing name/description, non-object input', () => {
    expect(toAvailableCommands({ sessionUpdate: 'available_commands_update' } as never)).toBe(null);
    expect(
      toAvailableCommands({ sessionUpdate: 'available_commands_update', availableCommands: 'nope' } as never),
    ).toBe(null);
    expect(
      toAvailableCommands({ sessionUpdate: 'available_commands_update', availableCommands: ['x'] } as never),
    ).toBe(null);
    expect(
      toAvailableCommands({
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ description: 'no name' }],
      } as never),
    ).toBe(null);
    expect(
      toAvailableCommands({
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'x', input: { hint: 'h' } }],
      } as never),
    ).toBe(null);
    expect(
      toAvailableCommands({
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'x', description: 'd', input: 'oops' }],
      } as never),
    ).toBe(null);
  });

  it('routes a well-formed update to commands_update, a malformed one to unsupported + warn', () => {
    const good = note({
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'status', description: '查看状态' }],
    });
    expect(toAcpUpdates(good)).toEqual([
      {
        sessionUpdate: 'commands_update',
        commands: [{ name: 'status', description: '查看状态', inputHint: null }],
        raw: good,
      },
    ]);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = note({ sessionUpdate: 'available_commands_update', availableCommands: 7 });
    expect(toAcpUpdates(bad)).toEqual([{ sessionUpdate: 'unsupported', raw: bad }]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('available_commands_update'));
    warnSpy.mockRestore();
  });
});

describe('toConfigOptions (session config whitelisting)', () => {
  const flatSelect = {
    id: 'model',
    name: 'Model',
    description: '使用的模型',
    category: 'model',
    type: 'select',
    currentValue: 'glm-4.7',
    options: [
      { value: 'glm-4.7', name: 'GLM-4.7', description: '默认' },
      { value: 'glm-4.7-air', name: 'GLM-4.7-Air' },
    ],
  };
  const groupedSelect = {
    id: 'notify',
    name: '通知',
    type: 'select',
    currentValue: 'im',
    options: [
      { group: 'g1', name: '即时通讯', options: [{ value: 'im', name: 'Slack' }] },
      { group: 'g2', name: '邮件', options: [{ value: 'mail', name: '邮件' }] },
    ],
  };
  const bool = { id: 'verbose', name: '思考过程', type: 'boolean', currentValue: true };

  it('maps flat selects, grouped selects (flattened with group labels), and booleans', () => {
    expect(toConfigOptions([flatSelect, groupedSelect, bool])).toEqual([
      {
        type: 'select',
        id: 'model',
        name: 'Model',
        description: '使用的模型',
        category: 'model',
        currentValue: 'glm-4.7',
        choices: [
          { value: 'glm-4.7', name: 'GLM-4.7', description: '默认', group: null },
          { value: 'glm-4.7-air', name: 'GLM-4.7-Air', description: null, group: null },
        ],
      },
      {
        type: 'select',
        id: 'notify',
        name: '通知',
        description: null,
        category: null,
        currentValue: 'im',
        choices: [
          { value: 'im', name: 'Slack', description: null, group: '即时通讯' },
          { value: 'mail', name: '邮件', description: null, group: '邮件' },
        ],
      },
      { type: 'boolean', id: 'verbose', name: '思考过程', description: null, category: null, currentValue: true },
    ]);
  });

  it('rejects structural violations: non-array list, bad entry shape, bad currentValue', () => {
    expect(toConfigOptions(undefined)).toBe(null); // handled as "none" by callers
    expect(toConfigOptions('x')).toBe(null);
    expect(toConfigOptions(['x'])).toBe(null);
    expect(toConfigOptions([{ name: 'no id' }])).toBe(null);
    expect(toConfigOptions([{ id: 'x', name: 'n', type: 'select', currentValue: 7, options: [] }])).toBe(null);
    expect(toConfigOptions([{ id: 'x', name: 'n', type: 'boolean', currentValue: 'yes' }])).toBe(null);
    expect(toConfigOptions([{ id: 'x', name: 'n', type: 'select', currentValue: 'v', options: 'bad' }])).toBe(null);
  });

  it('skips alone an entry with an unrecognized type (spec: ignore that option), keeping the rest', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(toConfigOptions([{ id: 'x', name: 'n', type: 'future', currentValue: 1 }, bool])).toEqual([
      { type: 'boolean', id: 'verbose', name: '思考过程', description: null, category: null, currentValue: true },
    ]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("option x has unknown type future"));
    expect(toConfigOptions([{ id: 'x', name: 'n', type: 'future', currentValue: 1 }])).toEqual([]);
    warnSpy.mockRestore();
  });

  it('routes a well-formed config_option_update to config_options_update, malformed to unsupported + warn', () => {
    const good = note({
      sessionUpdate: 'config_option_update',
      configOptions: [bool],
    });
    expect(toAcpUpdates(good)).toEqual([
      { sessionUpdate: 'config_options_update', options: [{ type: 'boolean', id: 'verbose', name: '思考过程', description: null, category: null, currentValue: true }], raw: good },
    ]);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = note({ sessionUpdate: 'config_option_update', configOptions: { nope: true } });
    expect(toAcpUpdates(bad)).toEqual([{ sessionUpdate: 'unsupported', raw: bad }]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('config_option_update'));
    warnSpy.mockRestore();
  });
});

  it('passes a late kind and rawInput through tool_call_update (merge inputs for the reducer)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const n = note({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't-5',
      kind: 'execute',
      rawInput: { command: 'pnpm test' },
    } as object);
    expect(toAcpUpdates(n)).toMatchObject([
      { sessionUpdate: 'tool_call_update', toolCallId: 't-5', kind: 'execute', rawInput: { command: 'pnpm test' } },
    ]);

    const bad = note({ sessionUpdate: 'tool_call_update', toolCallId: 't-6', rawInput: 'oops' } as object);
    expect(toAcpUpdates(bad)).toMatchObject([{ sessionUpdate: 'tool_call_update', toolCallId: 't-6', rawInput: undefined }]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('rawInput'));
    warnSpy.mockRestore();
  });
