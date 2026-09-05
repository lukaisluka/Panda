import type {
  AcpAvailableCommand,
  AcpConfigOption,
  AcpContentBlock,
  AcpSessionModeState,
  AcpSessionUpdate,
  AcpToolCallStatus,
  AcpToolKind,
  ElicitationRequest,
  ElicitationResponse,
  PermissionOptionKind,
  PermissionRequest,
  SessionStatus,
} from '../protocol/types';
import type { ReplayStep } from './types';

/**
 * Hand-scripted Claude Code-style sessions used to drive the UI in Phase 0.
 * The pacing, chunk sizes and diff shapes here are what the message stream
 * gets visually calibrated against — treat them as design fixtures.
 */

/**
 * The demo agent's session modes — mirrors the test-agent's three permission
 * modes (ask_before_edits / accept_edits / accept_everything) so what the
 * picker shows in demo replay is what live testing against test-agent shows.
 */
export const DEMO_MODES: AcpSessionModeState = {
  currentModeId: 'ask_before_edits',
  availableModes: [
    { id: 'ask_before_edits', name: 'Ask before edits', description: '每一步写入/编辑/执行都要经过权限确认' },
    { id: 'accept_edits', name: 'Accept edits', description: '自动接受文件改动,仅命令执行与计划需要确认' },
    { id: 'accept_everything', name: 'Accept everything', description: '全自动,不请求任何权限' },
  ],
};

/**
 * The demo agent's slash commands — what the composer's `/` autocomplete
 * offers in replay. Mirrors the narrative: /status reports working-tree
 * state, /tag cuts a release tag, /ci pushes and starts CI (the url-mode
 * authorization beat hands the same job to the agent).
 */
const DEMO_COMMANDS: AcpAvailableCommand[] = [
  { name: 'status', description: '查看当前分支与改动状态', inputHint: null },
  { name: 'tag', description: '给当前分支打发布 tag', inputHint: 'tag 版本号,如 v1.3.0' },
  { name: 'ci', description: '推送分支并触发 CI', inputHint: '留空使用默认 workflow' },
];

/**
 * The demo agent's session config options — what the composer's settings
 * panel offers in replay. Mirrors what the test-agent (deepagents-acp)
 * actually models: a model selector and permission-mode selectors are its
 * two real config options; the grouped "notifications" select exercises the
 * optgroup rendering path.
 */
export const DEMO_CONFIG_OPTIONS: AcpConfigOption[] = [
  {
    type: 'select',
    id: 'model',
    name: 'Model',
    description: '当前会话使用的模型',
    category: 'model',
    currentValue: 'glm-4.7',
    choices: [
      { value: 'glm-4.7', name: 'GLM-4.7', description: '默认,平衡速度与质量', group: null },
      { value: 'glm-4.7-air', name: 'GLM-4.7-Air', description: '更快,轻量任务', group: null },
      { value: 'glm-4.6', name: 'GLM-4.6', description: '上一代,行为稳定', group: null },
    ],
  },
  {
    type: 'select',
    id: 'notifications',
    name: '完成通知',
    description: '回合结束后通过哪些渠道通知',
    category: 'notifications',
    currentValue: 'im',
    choices: [
      { value: 'im', name: 'Slack', description: null, group: '即时通讯' },
      { value: 'im-teams', name: 'Teams', description: null, group: '即时通讯' },
      { value: 'mail', name: '邮件', description: null, group: '邮件' },
      { value: 'sms', name: '短信', description: null, group: '邮件' },
    ],
  },
  {
    type: 'boolean',
    id: 'verbose-thinking',
    name: '显示思考过程',
    description: '在消息流中展示 agent 的思考摘要',
    category: 'display',
    currentValue: true,
  },
];

const text = (t: string): AcpContentBlock => ({ type: 'text', text: t });

/** Base64 SVG standing in for an agent-produced screenshot (test output). */
const image = (data: string, mimeType = 'image/svg+xml'): AcpContentBlock => ({ type: 'image', data, mimeType });

const TEST_OUTPUT_IMAGE = image(
  'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMjAiIGhlaWdodD0iOTYiPjxyZWN0IHdpZHRoPSIzMjAiIGhlaWdodD0iOTYiIHJ4PSI4IiBmaWxsPSIjMTIyMTFhIi8+PHRleHQgeD0iMTQiIHk9IjI2IiBmaWxsPSIjN2VlMmE4IiBmb250LWZhbWlseT0idWktbW9ub3NwYWNlLG1vbm9zcGFjZSIgZm9udC1zaXplPSIxMyI+cG5wbSB0ZXN0IHNyYy9fX3Rlc3RzX18vYXV0aC5zcGVjLnRzPC90ZXh0Pjx0ZXh0IHg9IjE0IiB5PSI0OCIgZmlsbD0iIzlhYTg5YiIgZm9udC1mYW1pbHk9InVpLW1vbm9zcGFjZSxtb25vc3BhY2UiIGZvbnQtc2l6ZT0iMTIiPuKckyBoYW5kbGVMb2dpbiAoMTJtcyk8L3RleHQ+PHRleHQgeD0iMTQiIHk9IjY4IiBmaWxsPSIjOWFhODliIiBmb250LWZhbWlseT0idWktbW9ub3NwYWNlLG1vbm9zcGFjZSIgZm9udC1zaXplPSIxMiI+4pyTIHJlZnJlc2hUb2tlbiAoOW1zKTwvdGV4dD48dGV4dCB4PSIxNCIgeT0iODgiIGZpbGw9IiM5YWE4OWIiIGZvbnQtZmFtaWx5PSJ1aS1tb25vc3BhY2UsbW9ub3NwYWNlIiBmb250LXNpemU9IjEyIj7inJMgdmVyaWZ5U2Vzc2lvbiAoMjFtcyk8L3RleHQ+PC9zdmc+',
);

// ---------------------------------------------------------------------------
// Step helpers
// ---------------------------------------------------------------------------

const updateStep = (update: AcpSessionUpdate, afterMs: number): ReplayStep => ({
  kind: 'update',
  afterMs,
  update,
});

const statusStep = (status: SessionStatus, afterMs: number): ReplayStep => ({
  kind: 'status',
  afterMs,
  status,
});

const toolCallStep = (
  toolCallId: string,
  title: string,
  kind: AcpToolKind,
  path: string,
  rawInput?: Record<string, unknown>,
  afterMs = 450,
): ReplayStep =>
  updateStep(
    {
      sessionUpdate: 'tool_call',
      toolCallId,
      title,
      kind,
      status: 'pending',
      rawInput,
      locations: [{ path }],
    },
    afterMs,
  );

const toolStatusStep = (toolCallId: string, status: AcpToolCallStatus, afterMs: number): ReplayStep =>
  updateStep({ sessionUpdate: 'tool_call_update', toolCallId, status }, afterMs);

const toolResultStep = (
  toolCallId: string,
  resultText: string,
  afterMs: number,
): ReplayStep =>
  updateStep(
    {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'completed',
      content: [{ type: 'content', content: text(resultText) }],
    },
    afterMs,
  );

function streamText(
  sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk',
  messageId: string,
  md: string,
  { firstMs = 350, chunk = 14, gapMs = 45 }: { firstMs?: number; chunk?: number; gapMs?: number } = {},
): ReplayStep[] {
  const chars = Array.from(md);
  const steps: ReplayStep[] = [];
  for (let i = 0; i < chars.length; i += chunk) {
    steps.push({
      kind: 'update',
      afterMs: i === 0 ? firstMs : gapMs,
      update: {
        sessionUpdate,
        messageId,
        content: { type: 'text', text: chars.slice(i, i + chunk).join('') },
      },
    });
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Diff fixture: the "before" and "after" of src/auth/session.ts
// ---------------------------------------------------------------------------

const OLD_SESSION_TS = String.raw`import { createHmac, timingSafeEqual } from 'crypto';

export function handleLogin(token: string, secret: string) {
  if (!token || token.length < 32) return false;
  const expected = createHmac('sha256', secret).update(token).digest();
  return timingSafeEqual(Buffer.from(token), expected);
}

export function refreshToken(token: string, secret: string) {
  if (token.length < 32) return false;
  const expected = createHmac('sha256', secret).update(token).digest();
  return timingSafeEqual(Buffer.from(token), expected);
}`;

const NEW_SESSION_TS = String.raw`import { createHmac, timingSafeEqual } from 'crypto';

export function verifySession(token: string, secret: string): boolean {
  if (!token || token.length < 32) return false;
  const expected = createHmac('sha256', secret).update(token).digest();
  return timingSafeEqual(Buffer.from(token), expected);
}

export function handleLogin(token: string, secret: string) {
  return verifySession(token, secret);
}

export function refreshToken(token: string, secret: string) {
  return verifySession(token, secret);
}`;

// ---------------------------------------------------------------------------
// Main scenario: "extract the duplicated token validation"
// ---------------------------------------------------------------------------

const permissionRequest: PermissionRequest = {
  toolCallId: 'edit-1',
  title: 'Edit file: src/auth/session.ts',
  options: [
    { id: 'allow_once', name: 'Allow once', kind: 'allow_once' },
    { id: 'allow_always', name: 'Always allow for this file', kind: 'allow_always' },
    { id: 'reject_once', name: 'Reject', kind: 'reject_once' },
  ],
};

const planReading = [
  { content: '读取 src/auth/session.ts，确认两处重复实现的现状', priority: 'high' as const, status: 'in_progress' as const },
  { content: '抽取 verifySession()，让两处调用点委托', priority: 'high' as const, status: 'pending' as const },
  { content: '跑一遍 auth 测试，确认行为不变', priority: 'medium' as const, status: 'pending' as const },
];

const planEditing = [
  { ...planReading[0]!, status: 'completed' as const },
  { ...planReading[1]!, status: 'in_progress' as const },
  planReading[2]!,
];

const planTesting = [
  { ...planReading[0]!, status: 'completed' as const },
  { ...planReading[1]!, status: 'completed' as const },
  { ...planReading[2]!, status: 'in_progress' as const },
];

const planDone = planTesting.map((e) => ({ ...e, status: 'completed' as const }));

const thoughtIntro =
  '校验逻辑重复在 handleLogin 和 refreshToken 两处……先读 session.ts 确认现状，再搜一遍引用点，确认改动不会漏掉调用方。';

const messageAfterRead = `现状确认了：校验逻辑重复了两份，而且**不一致**——\`handleLogin\` 做了 \`!token\` 空值检查，\`refreshToken\` 没有，null token 会直接抛 TypeError。我把它抽成唯一的 \`verifySession()\`：

~~~ts
export function verifySession(token: string, secret: string): boolean {
  if (!token || token.length < 32) return false;
  const expected = createHmac('sha256', secret).update(token).digest();
  return timingSafeEqual(Buffer.from(token), expected);
}
~~~

两个调用点都改为委托给它，行为以 \`handleLogin\` 的版本为准（带空值防护）。`;

const messageAfterEdit =
  '改完了，`handleLogin` 和 `refreshToken` 现在都是单行委托，校验统一收敛在 `verifySession()` 里，顺手修掉了空 token 抛 TypeError 的隐患。接下来跑一遍 auth 测试确认行为没变。';

const messageFinal = `测试全绿（3 passed）。这次重构总结：

- 校验逻辑收敛到 \`verifySession()\` 一处，两处调用点行为统一
- 修复 \`refreshToken\` 对空 token 抛异常的隐藏 bug
- 后续加过期时间、黑名单等规则，只需要动一个函数

现在的核心实现长这样：

\`\`\`ts
export function verifySession(token: string, secret: string): boolean {
  if (!token || token.length < 32) return false;
  const expected = createHmac('sha256', secret).update(token).digest();
  return timingSafeEqual(Buffer.from(token), expected);
}
\`\`\`

还有想调整的地方随时说。`;

const usageFinal = updateStep(
  {
    sessionUpdate: 'usage_update',
    used: 48_213,
    size: 200_000,
    cost: { amount: 0.34, currency: 'USD' },
  },
  300,
);

/** What happens after the user approves the edit. */
function allowBranch(): ReplayStep[] {
  return [
    statusStep('running', 150),
    toolStatusStep('edit-1', 'in_progress', 350),
    updateStep(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'edit-1',
        status: 'completed',
        content: [
          { type: 'diff', path: 'src/auth/session.ts', oldText: OLD_SESSION_TS, newText: NEW_SESSION_TS },
        ],
      },
      550,
    ),
    updateStep({ sessionUpdate: 'plan', entries: planEditing }, 250),
    ...streamText('agent_message_chunk', 'msg-2', messageAfterEdit, { firstMs: 500 }),
    toolCallStep('test-1', 'Run auth test suite', 'execute', 'auth.spec.ts', { command: 'pnpm test src/__tests__/auth.spec.ts' }, 500),
    updateStep({ sessionUpdate: 'plan', entries: planTesting }, 200),
    toolStatusStep('test-1', 'in_progress', 350),
    updateStep(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'test-1',
        status: 'completed',
        content: [
          { type: 'content', content: text('auth.spec.ts — 3 passed, 0 failed (42ms)') },
          { type: 'content', content: TEST_OUTPUT_IMAGE },
        ],
      },
      700,
    ),
    // Tests green — pushing the branch needs GitHub, which only the user can
    // authorize. The url-mode elicitation demos consent → open → complete.
    {
      kind: 'elicitation_url',
      afterMs: 500,
      request: elicitUrlRequest,
      onResolve: () => [
        statusStep('running', 200),
        ...streamText(
          'agent_message_chunk',
          'msg-ci-skip',
          '好，不连 GitHub 了——改动都已在本地验证过，分支留在本地，需要推送时你自己来。',
          { firstMs: 450 },
        ),
        ...finalTail(),
      ],
      onOpen: () => [
        statusStep('running', 200),
        // The out-of-band OAuth flow runs while the card waits on it; the
        // agent's elicitation/complete notification then lands.
        { kind: 'elicitation_url_complete', afterMs: 1800, elicitationId: elicitUrlRequest.id },
        ...streamText(
          'agent_message_chunk',
          'msg-ci-ok',
          'GitHub 已连接，分支 `auth-refactor` 已推送，CI 已排队（run #128）。结果出来我会汇报。',
          { firstMs: 450 },
        ),
        ...finalTail(),
      ],
    },
  ];
}

/** The closing beat every allow path shares (summary message + plan + usage). */
function finalTail(): ReplayStep[] {
  return [
    ...streamText('agent_message_chunk', 'msg-3', messageFinal, { firstMs: 550 }),
    updateStep({ sessionUpdate: 'agent_message_chunk', messageId: 'msg-3', content: TEST_OUTPUT_IMAGE }, 300),
    updateStep({ sessionUpdate: 'plan', entries: planDone }, 250),
    usageFinal,
    statusStep('idle', 400),
  ];
}

/** What happens after the user rejects the edit. */
function rejectBranch(): ReplayStep[] {
  return [
    toolStatusStep('edit-1', 'cancelled', 300),
    updateStep(
      {
        sessionUpdate: 'plan',
        entries: [
          { ...planReading[0]!, status: 'completed' as const },
          { ...planReading[1]!, status: 'pending' as const },
          planReading[2]!,
        ],
      },
      200,
    ),
    ...streamText(
      'agent_message_chunk',
      'msg-2-reject',
      '好——这次编辑没有执行，文件保持原样。想先看看我准备做的具体改动，还是换个方式推进？',
      { firstMs: 400 },
    ),
    usageFinal,
    statusStep('idle', 400),
  ];
}

/** The edit request + its permission gate — shared by both elicitation branches. */
function editSteps(): ReplayStep[] {
  return [
    toolCallStep(
      'edit-1',
      'Edit src/auth/session.ts — extract verifySession()',
      'edit',
      'src/auth/session.ts',
      { path: 'src/auth/session.ts', description: 'Extract verifySession() from handleLogin/refreshToken' },
      600,
    ),
    {
      kind: 'permission',
      afterMs: 150,
      request: permissionRequest,
      onResolve: (decision: PermissionOptionKind) =>
        decision === 'reject_once' ? rejectBranch() : allowBranch(),
    },
  ];
}

/**
 * The form-mode elicitation fixture: one field per schema type (free string,
 * enum string, boolean, multiselect, integer) so the demo calibrates every
 * form control the live wire schema can produce.
 */
const elicitRequest: ElicitationRequest = {
  mode: 'form',
  id: 'elicit-1',
  toolCallId: null,
  title: '重构选项确认',
  description: '动手改 session.ts 之前，确认几个执行选项。',
  fields: [
    {
      key: 'tag',
      type: 'string',
      title: '发布 tag',
      description: '重构合入后打的 git tag',
      required: true,
      options: null,
    },
    {
      key: 'strategy',
      type: 'string',
      title: '迁移策略',
      required: true,
      default: 'alias',
      options: [
        { value: 'alias', label: '保留旧名别名（渐进）' },
        { value: 'replace', label: '直接替换（彻底）' },
      ],
    },
    {
      key: 'notify',
      type: 'boolean',
      title: '完成后通知 #auth-review 频道',
      required: false,
      default: true,
    },
    {
      key: 'scope',
      type: 'multiselect',
      title: '同步更新的范围',
      required: false,
      default: ['tests'],
      options: [
        { value: 'tests', label: '测试' },
        { value: 'docs', label: '文档' },
        { value: 'examples', label: '示例' },
      ],
    },
    {
      key: 'priority',
      type: 'integer',
      title: '评审优先级（1-5，选填）',
      required: false,
    },
  ],
};

/**
 * The url-mode elicitation fixture: consent to an external OAuth flow. The
 * card shows the message + full URL + highlighted host; accepting opens the
 * link and the timeline waits for the (scripted) elicitation/complete.
 */
const elicitUrlRequest: ElicitationRequest = {
  mode: 'url',
  id: 'elicit-url-1',
  toolCallId: null,
  message: '改动已就绪。要推送分支并触发 CI 吗？需要你授权连接 GitHub。',
  url: 'https://github.com/login/oauth/authorize?client_id=panda-demo&scope=repo',
};

/** What happens after the user answers the elicitation form. */
function elicitBranch(response: ElicitationResponse): ReplayStep[] {
  if (response.outcome !== 'accepted') {
    return [
      statusStep('running', 150),
      ...streamText(
        'agent_message_chunk',
        'msg-elicit-declined',
        '好，不问细节了——按默认方式推进：保留旧名别名过渡，改完直接跑测试。',
        { firstMs: 400 },
      ),
      ...editSteps(),
    ];
  }
  const strategy = response.content.strategy === 'replace' ? '直接替换旧函数' : '保留旧名别名过渡';
  return [
    statusStep('running', 150),
    ...streamText(
      'agent_message_chunk',
      'msg-elicit-ok',
      `收到：${strategy}，完成后打 tag \`${String(response.content.tag)}\`。开始动手。`,
      { firstMs: 400 },
    ),
    ...editSteps(),
  ];
}

export function mainScenario(): ReplayStep[] {
  return [
    // Slash commands arrive before any turn: the agent advertises its list
    // up front, so typing `/` in the composer autocompletes from step one.
    updateStep({ sessionUpdate: 'commands_update', commands: DEMO_COMMANDS }, 300),
    // End-to-end command run: the user types /status and the command goes
    // over as a plain text prompt — the agent recognizes the prefix itself.
    updateStep({ sessionUpdate: 'user_message', content: [text('/status')] }, 400),
    statusStep('running', 200),
    ...streamText(
      'agent_message_chunk',
      'msg-status',
      '分支 `auth-refactor` 干净——没有未提交改动，上次 CI 全绿（3 passed）。要动手的话直接说。',
      { firstMs: 400, chunk: 6, gapMs: 30 },
    ),
    statusStep('idle', 250),
    updateStep(
      {
        sessionUpdate: 'user_message',
        content: [
          text(
            '把 `src/auth/session.ts` 里 token 校验的逻辑抽成独立函数——`handleLogin` 和 `refreshToken` 两处现在是重复实现。',
          ),
        ],
      },
      600,
    ),
    statusStep('running', 250),
    ...streamText('agent_thought_chunk', 'thought-1', thoughtIntro, { firstMs: 400 }),
    updateStep({ sessionUpdate: 'plan', entries: planReading }, 350),
    toolCallStep('read-1', 'Read src/auth/session.ts', 'read', 'src/auth/session.ts', { path: 'src/auth/session.ts' }, 400),
    toolStatusStep('read-1', 'in_progress', 300),
    // 工具结果是文件原文(#87:与随后 edit diff 的 oldText 同一份),不再
    // 是散文总结——#83 起 read 结果按原文代码块渲染,假散文在 mono 框里失真
    toolResultStep('read-1', OLD_SESSION_TS, 650),
    toolCallStep('search-1', 'Search references to the validation', 'search', 'src/auth/', { pattern: 'createHmac' }, 250),
    toolStatusStep('search-1', 'in_progress', 300),
    // grep 风格的匹配行(#87):与 read 的原文渲染保持同一叙事
    toolResultStep(
      'search-1',
      [
        'src/auth/session.ts:1:9:import { createHmac, timingSafeEqual } from \'crypto\';',
        'src/auth/session.ts:5:20:  const expected = createHmac(\'sha256\', secret).update(token).digest();',
        'src/auth/session.ts:11:20:  const expected = createHmac(\'sha256\', secret).update(token).digest();',
      ].join('\n'),
      450,
    ),
    ...streamText('agent_message_chunk', 'msg-1', messageAfterRead, { firstMs: 500 }),
    {
      kind: 'elicitation',
      afterMs: 500,
      request: elicitRequest,
      onResolve: elicitBranch,
    },
  ];
}

// ---------------------------------------------------------------------------
// Follow-up scenario: short scripted reply after the user sends anything
// ---------------------------------------------------------------------------

export function followUpScenario(userContent: AcpContentBlock[]): ReplayStep[] {
  const reply =
    '（demo 回放）Phase 0 还没有接真 agent——你的消息已经走完整条链路：composer → `user_message` 事件 → reducer → 消息流渲染。Phase 1 接上 claude-agent-acp 之后，这里会是 Claude Code 的真实回复。';
  return [
    updateStep({ sessionUpdate: 'user_message', content: userContent }, 120),
    statusStep('running', 200),
    ...streamText('agent_thought_chunk', 'thought-followup', '收到，继续推进。', { firstMs: 300, chunk: 5, gapMs: 30 }),
    ...streamText('agent_message_chunk', 'msg-followup', reply, { firstMs: 350, chunk: 18 }),
    updateStep(
      {
        sessionUpdate: 'usage_update',
        used: 56_410,
        size: 200_000,
        cost: { amount: 0.41, currency: 'USD' },
      },
      300,
    ),
    statusStep('idle', 350),
  ];
}

// ---------------------------------------------------------------------------
// Long-session scenario: virtualization / scroll calibration sample (?demo=long)
// ---------------------------------------------------------------------------

/**
 * Streams `turns` compact turns at a realistic burst pace — the calibration
 * sample for long-session virtualization. Start the dev server with
 * `?demo=long` to run it instead of the scripted scenario.
 *
 * Pacing note: 15ms/step (~66 updates/sec) mirrors how a fast WS replay
 * actually lands after React batching. Pacing per-step timers below ~5ms
 * (200+ renders/sec) is an unrealistically hostile mode in which
 * react-virtuoso's own recalculation machinery stalls — not a Panda bug.
 */
export function longScenario(turns = 80): ReplayStep[] {
  const steps: ReplayStep[] = [];
  const step = (s: ReplayStep, ms = 15): ReplayStep => ({ ...s, afterMs: ms });
  for (let i = 1; i <= turns; i++) {
    steps.push(
      updateStep(
        {
          sessionUpdate: 'user_message',
          content: [text(`第 ${i} 个请求：检查模块 ${i} 的错误处理，确认没有遗漏的边界情况。`)],
        },
        15,
      ),
    );
    steps.push(step(statusStep('running', 15)));
    steps.push(
      ...streamText(
        'agent_thought_chunk',
        `long-thought-${i}`,
        `模块 ${i} 的错误处理需要核对三层调用。`,
        { firstMs: 15, chunk: 12, gapMs: 15 },
      ),
    );
    steps.push(
      step(
        toolCallStep(`long-tool-${i}`, `Scan src/mod-${i}.ts`, 'search', `src/mod-${i}.ts`, { pattern: 'catch' }),
      ),
    );
    steps.push(step(toolStatusStep(`long-tool-${i}`, 'in_progress', 15)));
    steps.push(step(toolResultStep(`long-tool-${i}`, `mod-${i}.ts — 3 处 catch，全部有日志，无静默吞错。`, 15)));
    steps.push(
      ...streamText(
        'agent_message_chunk',
        `long-msg-${i}`,
        `模块 ${i} 检查完毕：错误处理完整，` +
          `${i % 7 === 0 ? '但有一处重复的兜底逻辑，建议合并。' : '边界情况都覆盖到了，无需修改。'}\n\n` +
          `本条消息故意写得长一点，用来校准长会话下的行高与滚动表现。`,
        { firstMs: 15, chunk: 28, gapMs: 15 },
      ),
    );
    steps.push(
      updateStep(
        {
          sessionUpdate: 'usage_update',
          used: 10_000 + i * 900,
          size: 200_000,
          cost: { amount: 0.1 + i * 0.01, currency: 'USD' },
        },
        15,
      ),
    );
    steps.push(step(statusStep('idle', 15)));
  }
  return steps;
}
