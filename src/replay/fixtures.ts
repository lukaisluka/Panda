import type {
  AcpContentBlock,
  AcpSessionUpdate,
  AcpToolCallStatus,
  AcpToolKind,
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

const text = (t: string): AcpContentBlock => ({ type: 'text', text: t });

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
    { id: 'reject', name: 'Reject', kind: 'reject' },
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
    toolResultStep('test-1', 'auth.spec.ts — 3 passed, 0 failed (42ms)', 700),
    ...streamText('agent_message_chunk', 'msg-3', messageFinal, { firstMs: 550 }),
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

export function mainScenario(): ReplayStep[] {
  return [
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
    toolResultStep(
      'read-1',
      'session.ts 共 18 行。HMAC 校验在 handleLogin 与 refreshToken 中各重复一份，且后者缺空值防护。文件无其他导出。',
      650,
    ),
    toolCallStep('search-1', 'Search references to the validation', 'search', 'src/auth/', { pattern: 'createHmac' }, 250),
    toolStatusStep('search-1', 'in_progress', 300),
    toolResultStep('search-1', '2 处引用：handleLogin、refreshToken，均在 src/auth/session.ts 内。', 450),
    ...streamText('agent_message_chunk', 'msg-1', messageAfterRead, { firstMs: 500 }),
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
        decision === 'reject' ? rejectBranch() : allowBranch(),
    },
  ];
}

// ---------------------------------------------------------------------------
// Follow-up scenario: short scripted reply after the user sends anything
// ---------------------------------------------------------------------------

export function followUpScenario(userText: string): ReplayStep[] {
  const reply =
    '（demo 回放）Phase 0 还没有接真 agent——你的消息已经走完整条链路：composer → `user_message` 事件 → reducer → 消息流渲染。Phase 1 接上 claude-agent-acp 之后，这里会是 Claude Code 的真实回复。';
  return [
    updateStep({ sessionUpdate: 'user_message', content: [text(userText)] }, 120),
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