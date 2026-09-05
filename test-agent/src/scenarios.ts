/**
 * 确定性剧本:测试 agent 每一轮、每一步要「说」和「做」什么。
 *
 * 剧本由两个下标定位:
 * - 用户轮次 = 对话里 HumanMessage 的个数(第 1 轮播放完整故事,之后是简短回复)
 * - 步骤     = 最后一条 HumanMessage 之后已出现的 AIMessage 个数
 *   (LangGraph 一轮里模型可能被多次调用:每次工具循环都是一次模型调用)
 *
 * 故事线与 `src/replay/fixtures.ts` 的 mainScenario 呼应:重构 auth 校验。
 * 剧本文本与 e2e 断言(src/acp/LiveAcpClient.e2e.test.ts)逐字对齐,改动两侧必须同步。
 */

export interface ToolCall {
  /** 剧本步骤中的一个工具调用(deepagents 内置工具)。 */
  name: string;
  args: Record<string, unknown>;
}

export interface Step {
  /** 一次模型调用要返回的内容:思考块、工具调用与正文可以共存。
   *
   * `reasoning` 映射为 ACP 的 agent_thought_chunk,`text` 映射为
   * agent_message_chunk,`toolCalls` 驱动工具卡/计划/diff 等 update。
   */
  reasoning?: string;
  text?: string;
  toolCalls: ToolCall[];
}

export function step(reasoning: string | undefined, toolCalls: ToolCall[], text?: string): Step {
  return { reasoning, toolCalls, text };
}

export function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { name, args };
}

// 与 seed/auth.ts 精确对应:edit_file 的 old_string 必须在沙箱文件里唯一命中。
const EDIT_OLD = '  if (validateSession(session) == false) {';
const EDIT_NEW = '  if (!validateSession(session)) {';

// deepagents 的 backend 使用以 `/` 为根的虚拟路径(由 FilesystemBackend
// 映射到沙箱目录),因此剧本里的 file_path 都写成规范的虚拟绝对路径。
const AUTH = '/auth.ts';

const TURN_1: Step[] = [
  step(
    '用户要重构 auth 校验。我先列个计划,再读实现、做最小改动,最后用一条命令验证,避免一次改太多。',
    [
      toolCall('write_todos', {
        todos: [
          { content: '通读 auth.ts 现有校验逻辑', status: 'completed' },
          { content: '收紧 authorize 的布尔判断', status: 'in_progress' },
          { content: '用命令验证改动后的文件', status: 'pending' },
        ],
      }),
    ],
  ),
  step('先读一下 auth.ts 的现状,确认要改的位置。', [toolCall('read_file', { file_path: AUTH })]),
  step('找到了,`validateSession(...) == false` 是多余的宽松比较,改成显式取反。', [
    toolCall('edit_file', {
      file_path: AUTH,
      old_string: EDIT_OLD,
      new_string: EDIT_NEW,
    }),
  ]),
  step('改动完成,跑一条命令确认最终文件内容。', [toolCall('execute', { command: 'cat auth.ts' })]),
  step(
    '改动验证过了,总结一下。',
    [],
    '重构完成。`authorize` 里的布尔判断从宽松比较改成了显式取反,行为不变、可读性更好。\n\n' +
      '```ts\n' +
      `${EDIT_NEW}\n` +
      '```\n\n' +
      '**验证**:`cat auth.ts` 已确认改动落盘。测试 agent 的剧本到此播放完毕,' +
      '你可以继续发消息测试追加消息的渲染,或切换到真实模型。',
  ),
];

// 第 2 轮起:固定短回复,压测追加消息/多轮布局。
const FOLLOW_UP: Step[] = [
  step(
    '这是后续轮次,回一段固定文字即可。',
    [],
    '收到。完整故事只在每轮剧本的第 1 轮播放,之后每轮都回复这段固定文字,' +
      '便于验证**追加消息**与滚动行为。需要不可预测的输出时,请切换到真实模型。',
  ),
];

// 步骤用尽时的兜底(正常情况下 _FOLLOW_UP 一步就结束,这里防御性保留)。
const FALLBACK: Step[] = [step(undefined, [], '本轮剧本步骤已播完,这是兜底回复。')];

/** 返回第 userTurn 轮(1 起)第 step 步(0 起)的剧本内容。 */
export function scriptedStep(userTurn: number, stepIndex: number): Step {
  const turnScript = userTurn <= 1 ? TURN_1 : FOLLOW_UP;
  if (stepIndex < turnScript.length) {
    return turnScript[stepIndex]!;
  }
  return FALLBACK[0]!;
}
