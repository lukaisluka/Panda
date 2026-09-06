/**
 * ACP agent 壳:直接构建在官方 `@agentclientprotocol/sdk` 的
 * AgentSideConnection 上,把 deepagents(LangGraph 工具循环、真实文件
 * diff、HITL interrupt、SQLite 会话持久化)接到 ACP 协议。
 *
 * 为什么不用 npm 的 deepagents-acp(0.1.29):它的 DeepAgentsServer 把
 * 会话放在进程内存 Map 里(checkpointer 也是 MemorySaver),跨子进程的
 * session/load 直接 Session not found;权限请求发出后从不 resume 图——
 * HITL 是断的;且不支持 session config options(模型/模式切换)。本壳
 * 的 ACP 契约镜像 Python 版 deepagents-acp 0.0.11(Panda e2e 断言所钉
 * 死的行为):能力声明、三档模式 + mode/model configOptions、权限三选
 * 项、标题、回放。
 */

import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import type {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AuthenticateResponse,
  CloseSessionRequest,
  CloseSessionResponse,
  CreateElicitationResponse,
  DeleteSessionRequest,
  DeleteSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  LogoutRequest,
  LogoutResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionUpdate,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
} from '@agentclientprotocol/sdk';
import { titleFromFirstUserText } from './sessionTitles';
import { containsDangerousPatterns, extractCommandTypes, formatExecuteResult, truncateExecuteCommandForDisplay } from './commandPolicy';
import { buildDeepAgent, DEFAULT_MODE_ID, INTERRUPT_CONFIGS, MODES } from './agentConfig';
import type { LocalShellBackend } from 'deepagents';
import type { ModelRegistry } from './models';
import type { SessionStore, SessionRecord } from './sessionStore';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';

// 中文没有空格,按单字流出才像真实模型的增量输出;非中文字符按词流出
const WORD_RE = /[\u4e00-\u9fff]|[^\u4e00-\u9fff\s]+\s*/g;

function splitWords(text: string): string[] {
  return text.match(WORD_RE) ?? [];
}

interface Todo {
  content: string;
  status: string;
}

/** LangChain 内容块的松散视图(模型消息 content 可能是 string 或块数组)。 */
interface ContentBlockLike {
  type: string;
  text?: string;
  reasoning?: string;
}

function messageBlocks(message: BaseMessage): ContentBlockLike[] {
  const content = message.content;
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return Array.isArray(content) ? (content as ContentBlockLike[]) : [];
}

interface HitlInterrupt {
  id: string;
  value: {
    actionRequests: { name: string; args: Record<string, unknown>; description?: string }[];
    reviewConfigs: { actionName: string; allowedDecisions: string[] }[];
  };
}

type Decision = { type: 'approve' } | { type: 'reject'; message?: string };

export interface AgentServerDeps {
  version: string;
  models: ModelRegistry;
  checkpointer: BaseCheckpointSaver;
  store: SessionStore;
  backend: LocalShellBackend;
  log: (...args: unknown[]) => void;
}

/** 会话元数据的 ACP 视图(mode/model configOptions、modes 状态)。 */
function modeState(record: SessionRecord) {
  return { availableModes: MODES, currentModeId: record.modeId };
}

function configOptions(deps: AgentServerDeps, record: SessionRecord) {
  return [
    {
      id: 'mode',
      name: 'Session Mode',
      description: 'Controls how the agent requests permission',
      category: 'mode',
      type: 'select' as const,
      currentValue: record.modeId,
      options: MODES.map((mode) => ({ value: mode.id, name: mode.name, description: mode.description })),
    },
    {
      id: 'model',
      name: 'Model',
      description: 'The LLM model to use for this session',
      category: 'model',
      type: 'select' as const,
      currentValue: record.modelValue,
      options: deps.models.modelsList.map((model) => ({
        value: model.value,
        name: model.name,
        description: model.description ?? '',
      })),
    },
  ];
}

/** 创建一个 ACP Agent handler(每条 stdio 连接一份,持有会话内状态)。 */
export function createAgentHandler(conn: AgentSideConnection, deps: AgentServerDeps): Agent {
  // 会话内(=子进程内)状态:切连接即清空,与 Python 版一致
  const sessionPlans = new Map<string, Todo[]>();
  const allowedCommandTypes = new Map<string, Set<string>>();
  /** 假实现:v1 authenticate 无条件成功,这里只记录哪些方法被用过(#90)。 */
  const authenticatedMethodIds = new Set<string>();
  const activeToolCalls = new Map<string, { name: string; args: Record<string, unknown> }>();
  const agents = new Map<string, ReturnType<typeof buildDeepAgent>>();
  let cancelled = false;
  /** 确定性假用量:每回合固定增长,e2e 断言可预知(#99)。 */
  let usageTurns = 0;
  /** elicitation/compaction 的本地序号,保证 id 确定性。 */
  let flowSeq = 0;

  async function send(sessionId: string, update: SessionUpdate): Promise<void> {
    await conn.sessionUpdate({ sessionId, update });
  }

  function getAgent(record: SessionRecord) {
    const key = `${record.modelValue}|${record.modeId}`;
    let agent = agents.get(key);
    if (!agent) {
      const model = deps.models.instances.get(record.modelValue);
      if (!model) {
        // 不静默回退到剧本模型:客户端选了未注册的模型是配置错误,必须炸出来。
        throw new Error(
          `未注册的模型: ${record.modelValue},可用模型: ${[...deps.models.instances.keys()].join(', ')}`,
        );
      }
      agent = buildDeepAgent(model, record.modeId, deps.backend, deps.checkpointer);
      agents.set(key, agent);
    }
    return agent;
  }

  // —— 输出投影:LangGraph 消息 → ACP update ——

  const TOOL_KINDS: Record<string, 'read' | 'edit' | 'search' | 'execute' | 'other'> = {
    read_file: 'read',
    edit_file: 'edit',
    write_file: 'edit',
    ls: 'search',
    glob: 'search',
    grep: 'search',
    execute: 'execute',
  };

  async function emitContentChunks(sessionId: string, message: BaseMessage, messageId?: string): Promise<void> {
    for (const block of messageBlocks(message)) {
      if (block.type === 'reasoning' && typeof block.reasoning === 'string' && block.reasoning) {
        // 壳层合成分块:deepagents 的 JS 工具循环聚合输出模型消息,
        // 这里按词切成增量 chunk,保持 agent_thought_chunk 的增量渲染路径。
        for (const piece of splitWords(block.reasoning)) {
          await send(sessionId, {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: piece },
            ...(messageId !== undefined ? { messageId } : {}),
          });
        }
      } else if (block.type === 'text' && block.text) {
        for (const piece of splitWords(block.text)) {
          await send(sessionId, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: piece },
            ...(messageId !== undefined ? { messageId } : {}),
          });
        }
      }
    }
  }

  async function sendPlanUpdate(sessionId: string, todos: Todo[]): Promise<void> {
    const entries = todos.map((todo) => ({
      content: todo.content ?? '',
      status: (todo.status === 'pending' || todo.status === 'in_progress' || todo.status === 'completed' ? todo.status : 'pending') as
        | 'pending'
        | 'in_progress'
        | 'completed',
      priority: 'medium' as const,
    }));
    await send(sessionId, { sessionUpdate: 'plan', entries });
  }

  // —— #99:常驻通知与关键词触发的剧本化演示 ——

  /** 固定命令表:客户端拿去驱动斜杠命令自动补全。 */
  const AVAILABLE_COMMANDS = [
    { name: '/plan', description: '查看当前计划状态', input: { hint: '(无需参数)' } },
    { name: '/model', description: '列出本会话可用模型', input: { hint: '(无需参数)' } },
    { name: '/summarize', description: '总结当前会话', input: { hint: '总结范围,如 recent 或 all' } },
  ];

  async function sendAvailableCommands(sessionId: string): Promise<void> {
    await send(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: AVAILABLE_COMMANDS });
  }

  /**
   * 会话生命周期 RPC 的伴生通知:new/load 的 available_commands_update 若在
   * RPC response 之前发出,客户端的 session 过滤(this.sessionId 尚未随
   * resolve 更新)会把它们当 foreign session 丢掉。推迟到下一 macrotask:
   * response 必然已 flush(Panda e2e 钉住这个时序)。
   */
  function sendAvailableCommandsAfterResponse(sessionId: string): void {
    setTimeout(() => {
      sendAvailableCommands(sessionId).catch((error) => {
        deps.log(`[commands] available_commands_update 发送失败: ${String(error)}`);
      });
    }, 0);
  }

  /** 回合结束的确定性用量回报:used 按回合数线性增长,cost 同步放大。 */
  async function sendUsageUpdate(sessionId: string): Promise<void> {
    usageTurns += 1;
    await send(sessionId, {
      sessionUpdate: 'usage_update',
      used: usageTurns * 4096,
      size: 131_072,
      cost: { amount: Number((usageTurns * 0.001).toFixed(3)), currency: 'USD' },
    });
  }

  /**
   * 关键词触发的演示流(#99)。每个分支独立成段、先于剧本回合发送;触发回合
   * 仍走 streamTurn,HumanMessage 计数(剧本轮次定位)不受影响。返回 false
   * 表示客户端断开了触发流(elicitation 通道死),回合应按 cancelled 收尾。
   */
  async function runTriggerFlows(record: SessionRecord, promptText: string): Promise<boolean> {
    const sessionId = record.sessionId;
    try {
      if (promptText.includes('表单')) {
        flowSeq += 1;
        const response: CreateElicitationResponse = await conn.createElicitation({
          mode: 'form',
          sessionId,
          message: '部署前确认环境与选项',
          requestedSchema: {
            type: 'object',
            properties: {
              environment: { type: 'string', title: '部署环境', enum: ['staging', 'production'] },
              skipTests: { type: 'boolean', title: '跳过测试直接部署', default: false },
            },
            required: ['environment'],
          },
        });
        const answered = response.action === 'accept' ? JSON.stringify(response.content ?? {}) : `被${response.action}`;
        await send(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `表单触发完成(${answered})。继续剧本回合。\n\n` },
        });
      } else if (promptText.includes('打开链接')) {
        flowSeq += 1;
        const elicitationId = `elicit-url-${flowSeq}`;
        const response: CreateElicitationResponse = await conn.createElicitation({
          mode: 'url',
          sessionId,
          elicitationId,
          url: 'https://panda.test/oauth/consent',
          message: '打开链接完成外部授权(测试流程,浏览器动作由客户端决定)',
        });
        if (response.action === 'accept') {
          // url 模式收尾在 agent 侧:consent 已到,流程"完成",发 complete 通知
          // 让客户端的挂起请求落定(真实世界对应 OAuth 回调后)。
          await conn.completeElicitation({ elicitationId });
          await send(sessionId, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '链接授权已完成(elicitation/complete 已送达)。继续剧本回合。\n\n' },
          });
        } else {
          await send(sessionId, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `链接授权${response.action},跳过外部流程。继续剧本回合。\n\n` },
          });
        }
      } else if (promptText.includes('压缩上下文')) {
        flowSeq += 1;
        const compactionId = `compaction-${flowSeq}`;
        await send(sessionId, { sessionUpdate: 'compaction_update', compactionId, status: 'in_progress' });
        await send(sessionId, {
          sessionUpdate: 'compaction_summary_chunk',
          compactionId,
          content: { type: 'text', text: '会话前几轮的工具调用与结果已折叠。' },
        });
        await send(sessionId, {
          sessionUpdate: 'compaction_summary_chunk',
          compactionId,
          content: { type: 'text', text: '保留了重构决策与验证结论。' },
        });
        await send(sessionId, {
          sessionUpdate: 'compaction_update',
          compactionId,
          status: 'completed',
          summary: [{ type: 'text', text: '早期调试轮次压缩为一条摘要,上下文已释放。' }],
        });
      } else if (promptText.includes('清理计划')) {
        // UNSTABLE plan 变体:plan_update(items) 全部标记完成后撤下计划。
        const planId = 'main';
        await send(sessionId, {
          sessionUpdate: 'plan_update',
          plan: {
            type: 'items',
            planId,
            entries: [
              { content: '通读 auth.ts 现有校验逻辑', status: 'completed', priority: 'medium' },
              { content: '收紧 authorize 的布尔判断', status: 'completed', priority: 'medium' },
              { content: '用命令验证改动后的文件', status: 'completed', priority: 'medium' },
            ],
          },
        } as SessionUpdate);
        await send(sessionId, { sessionUpdate: 'plan_removed', planId });
      }
      return true;
    } catch (error) {
      // 触发流死了(客户端断开/通道异常):不静默,回合按 cancelled 收尾。
      deps.log(`[trigger] 触发流失败,回合取消: ${String(error)}`);
      return false;
    }
  }

  async function emitToolCallStart(sessionId: string, toolCallId: string, name: string, args: Record<string, unknown>): Promise<void> {
    const kind = TOOL_KINDS[name] ?? 'other';
    let update: Record<string, unknown>;
    if (name === 'read_file' && typeof args.file_path === 'string') {
      // locations 让客户端渲染成文件行(动词+文件图标+文件名+目录)
      update = { title: `Read \`${args.file_path}\``, locations: [{ path: args.file_path }] };
    } else if (name === 'edit_file' && typeof args.file_path === 'string') {
      const path = args.file_path;
      update = {
        title: `Edit \`${path}\``,
        // diff 在 start 事件上:Panda 的 wire 投影会把它转成一条
        // tool_call_update(渲染模型只认 update 上的 content)。
        content: [
          {
            type: 'diff',
            path,
            oldText: String(args.old_string ?? ''),
            newText: String(args.new_string ?? ''),
          },
        ],
        locations: [{ path }],
      };
    } else if (name === 'write_file' && typeof args.file_path === 'string') {
      // 协议 ToolKind 没有 write 枚举,创建按协议归类 edit:kind 仍是 edit,
      // 客户端动词显示 Edit,创建/修改靠 diff 统计的有无区分(创建无统计);
      // 原始 Write title 保留在文件名 hover。
      update = { title: `Write \`${args.file_path}\``, locations: [{ path: args.file_path }] };
    } else if (name === 'execute') {
      const command = typeof args.command === 'string' ? args.command : '';
      update = { title: command ? truncateExecuteCommandForDisplay(command) : 'Execute command' };
    } else {
      update = { title: name };
    }
    activeToolCalls.set(toolCallId, { name, args });
    await send(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId,
      kind,
      status: 'pending',
      rawInput: args,
      ...update,
    } as SessionUpdate);
    if (name === 'write_todos' && Array.isArray(args.todos)) {
      // 计划随工具卡 start 立即可见(执行结果还会再推一次状态)
      await sendPlanUpdate(sessionId, args.todos as Todo[]);
    }
  }

  async function emitAiMessage(sessionId: string, message: BaseMessage): Promise<void> {
    await emitContentChunks(sessionId, message);
    if (AIMessage.isInstance(message)) {
      for (const toolCall of message.tool_calls ?? []) {
        if (toolCall.id) {
          await emitToolCallStart(sessionId, toolCall.id, toolCall.name, toolCall.args as Record<string, unknown>);
        }
      }
    }
  }

  function toolText(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((block) => (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string' ? block.text : ''))
        .join('');
    }
    return String(content);
  }

  async function emitToolResult(sessionId: string, message: BaseMessage): Promise<void> {
    if (!ToolMessage.isInstance(message)) {
      return;
    }
    const active = activeToolCalls.get(message.tool_call_id);
    if (!active) {
      deps.log(`[tool] 结果对应的工具卡不存在: ${message.tool_call_id}(${message.name})`);
      return;
    }
    activeToolCalls.delete(message.tool_call_id);
    if (active.name === 'edit_file') {
      // diff 已随 start 送达,结果文本是冗余;但终态必须推进,否则卡片
      // 永远停在 pending,accept_edits 静默放行时会挂着「等待批准」误导用户
      await send(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: message.tool_call_id,
        status: message.status === 'error' ? 'failed' : 'completed',
      });
      return;
    }
    const raw = toolText(message.content);
    const text = active.name === 'execute' ? formatExecuteResult(String(active.args.command ?? ''), raw) : raw;
    await send(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: message.tool_call_id,
      status: message.status === 'error' ? 'failed' : 'completed',
      content: [{ type: 'content', content: { type: 'text', text } }],
    });
  }

  // —— HITL:interrupt → request_permission → Command(resume) ——

  function allTasksCompleted(plan: Todo[]): boolean {
    return plan.length === 0 || plan.every((todo) => todo.status === 'completed');
  }

  function permissionTitle(name: string, args: Record<string, unknown>): { title: string; planLog?: string } {
    if (name === 'write_todos') {
      const todos = (Array.isArray(args.todos) ? args.todos : []) as Todo[];
      const planText = todos.map((todo, i) => `${i + 1}. ${todo.content}`).join('\n');
      return { title: 'Review Plan', planLog: `## Plan\n\n${planText}\n` };
    }
    if (name === 'edit_file' && typeof args.file_path === 'string') {
      return { title: `Edit \`${args.file_path}\`` };
    }
    if (name === 'write_file' && typeof args.file_path === 'string') {
      return { title: `Write \`${args.file_path}\`` };
    }
    if (name === 'execute') {
      const command = typeof args.command === 'string' ? args.command : '';
      return { title: command ? `Execute: \`${truncateExecuteCommandForDisplay(command)}\`` : 'Execute command' };
    }
    return { title: name };
  }

  function optionLabel(name: string, args: Record<string, unknown>): string {
    // execute:按命令签名生成描述(如 `cat`、`cd`, `cat`);其他工具用工具名
    if (name === 'execute') {
      const command = typeof args.command === 'string' ? args.command : '';
      const types = extractCommandTypes(command);
      if (types.length > 0) {
        const desc = [...new Set(types)].map((t) => `\`${t}\``).join(', ');
        return `Always allow ${desc} commands`;
      }
    }
    return `Always allow ${name} commands`;
  }

  /** 键序无关的 JSON 串:HITL 传来的 args 可能被重新序列化过,
   * 与 tool_call 的 args 只保证深相等,不保证键序。 */
  function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map(stableStringify).join(',')}]`;
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
  }

  /**
   * HITL 的 ActionRequest 不带工具调用 id(langchain 类型只有 name/args/
   * description),interrupt.id 是中断自身的 id,拿它当权限卡 id 会在客户端
   * 落成一张永远没人推进的占位卡。工具卡在 start 事件时已按 toolCall.id
   * 登记,这里按 name+args 反查出真 id,让权限卡附着在真工具卡上。
   */
  function findToolCallIdForAction(name: string, args: Record<string, unknown>): string | null {
    const target = stableStringify(args);
    for (const [id, active] of activeToolCalls) {
      if (active.name === name && stableStringify(active.args) === target) {
        return id;
      }
    }
    return null;
  }

  /**
   * 处理一批 HITL interrupt:逐个向客户端请求权限,返回恢复图所需的
   * decisions。返回 null 表示回合被取消(客户端答了 cancelled 或权限通道
   * 断开)。
   */
  async function handleInterrupts(record: SessionRecord, interrupts: HitlInterrupt[]): Promise<Decision[] | null> {
    const sessionId = record.sessionId;
    const decisions: Decision[] = [];
    for (const interrupt of interrupts) {
      const actionRequests = interrupt.value?.actionRequests ?? [];
      for (const action of actionRequests) {
        const name = action.name;
        const args = action.args ?? {};

        // 模式动态生效(issue #79):interruptOn 固化在 createDeepAgent 构造
        // 参数里,进行中回合仍按旧模式挂起;这里按会话当前 mode 补一道检查,
        // 已不需要审批的工具静默放行,让「中途切模式」即时生效。modeId 必须
        // 现读 store——streamTurn 持有的 record 是回合开始时的旧引用,
        // set_session_mode 之后的 modeId 只存在于存储里。
        const stored = deps.store.get(sessionId);
        const modeId = stored?.modeId ?? record.modeId;
        const currentTier = INTERRUPT_CONFIGS[modeId];
        if (currentTier && !(name in currentTier)) {
          if (name === 'write_todos' && Array.isArray(args.todos)) {
            sessionPlans.set(sessionId, args.todos as Todo[]);
          }
          deps.log(`[permission] ${name} 不在当前模式(${modeId})审批清单,静默放行`);
          decisions.push({ type: 'approve' });
          continue;
        }

        // 计划进行中的 write_todos 增量更新自动放行
        if (name === 'write_todos' && Array.isArray(args.todos)) {
          const existing = sessionPlans.get(sessionId);
          if (existing && existing.length > 0 && !allTasksCompleted(existing)) {
            sessionPlans.set(sessionId, args.todos as Todo[]);
            deps.log('[permission] write_todos 计划增量更新,自动放行');
            decisions.push({ type: 'approve' });
            continue;
          }
        }

        // 同类命令已 always 放行
        const allowed = allowedCommandTypes.get(sessionId);
        if (allowed && allowed.size > 0) {
          if (name === 'execute' && typeof args.command === 'string') {
            if (!containsDangerousPatterns(args.command)) {
              const types = extractCommandTypes(args.command);
              if (types.length > 0 && types.every((type) => allowed.has(`execute:${type}`))) {
                deps.log(`[permission] execute 命令签名(${types.join(' ')})已 always 放行`);
                decisions.push({ type: 'approve' });
                continue;
              }
            }
          } else if (allowed.has(`${name}:`)) {
            deps.log(`[permission] ${name} 已 always 放行`);
            decisions.push({ type: 'approve' });
            continue;
          }
        }

        const { title, planLog } = permissionTitle(name, args);
        if (planLog) {
          await send(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: planLog } });
        }
        const toolCallId = findToolCallIdForAction(name, args) ?? interrupt.id;
        if (toolCallId === interrupt.id) {
          deps.log(`[permission] 未找到 ${name} 的工具卡,回退 interrupt.id: ${interrupt.id}`);
        }
        deps.log(`[permission] 请求审批: ${title}(${toolCallId})`);
        let response: { outcome?: { outcome: string; optionId?: string } } | undefined;
        try {
          response = (await conn.requestPermission({
            sessionId,
            toolCall: { toolCallId, title, rawInput: args },
            options: [
              { optionId: 'approve', name: 'Approve', kind: 'allow_once' },
              { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
              { optionId: 'approve_always', name: optionLabel(name, args), kind: 'allow_always' },
            ],
          })) as { outcome?: { outcome: string; optionId?: string } };
        } catch (error) {
          // 权限请求通道断了(客户端断开):回合必须终止,不能默默放行
          deps.log(`[permission] 请求失败,终止回合: ${String(error)}`);
          return null;
        }
        const outcome = response?.outcome;
        if (!outcome || outcome.outcome !== 'selected') {
          deps.log(`[permission] ${title} 被取消,终止回合`);
          return null; // cancelled
        }
        deps.log(`[permission] ${title} 收到决定: ${String(outcome.optionId)}`);
        if (outcome.optionId === 'approve') {
          if (name === 'write_todos' && Array.isArray(args.todos)) {
            sessionPlans.set(sessionId, args.todos as Todo[]);
          }
          decisions.push({ type: 'approve' });
        } else if (outcome.optionId === 'reject') {
          if (name === 'write_todos') {
            sessionPlans.set(sessionId, []);
            await sendPlanUpdate(sessionId, []);
          }
          decisions.push({ type: 'reject', message: '用户拒绝了该操作' });
        } else if (outcome.optionId === 'approve_always') {
          if (!allowedCommandTypes.has(sessionId)) {
            allowedCommandTypes.set(sessionId, new Set());
          }
          const set = allowedCommandTypes.get(sessionId)!;
          if (name === 'execute' && typeof args.command === 'string') {
            for (const type of extractCommandTypes(args.command)) {
              set.add(`execute:${type}`);
            }
          } else {
            set.add(`${name}:`);
          }
          if (name === 'write_todos' && Array.isArray(args.todos)) {
            sessionPlans.set(sessionId, args.todos as Todo[]);
          }
          decisions.push({ type: 'approve' });
        } else {
          deps.log(`[permission] 未知选项: ${String(outcome.optionId)}`);
          return null;
        }
      }
    }
    return decisions;
  }

  // —— prompt 主循环 ——

  function promptToHumanMessage(prompt: PromptRequest['prompt']): HumanMessage {
    const blocks: Record<string, unknown>[] = [];
    for (const block of prompt) {
      if (block.type === 'text' && typeof block.text === 'string') {
        blocks.push({ type: 'text', text: block.text });
      } else if (block.type === 'image' && typeof block.data === 'string') {
        blocks.push({
          type: 'image_url',
          image_url: { url: `data:${String(block.mimeType ?? 'image/png')};base64,${block.data}` },
        });
      } else {
        // 不静默丢弃未知块:落成文本让模型看得见
        blocks.push({ type: 'text', text: `[unsupported prompt block: ${block.type}]` });
      }
    }
    const content = blocks.length === 1 && blocks[0]!.type === 'text' ? blocks[0]!.text : blocks;
    return new HumanMessage({ content: content as unknown as HumanMessage['content'] });
  }

  async function streamTurn(record: SessionRecord, humanMessage: HumanMessage): Promise<PromptResponse['stopReason']> {
    const agent = getAgent(record);
    const config = { configurable: { thread_id: record.threadId } };
    let decisions: Decision[] = [];
    let resuming = false;
    while (true) {
      if (cancelled) {
        return 'cancelled';
      }
      const input = resuming ? new Command({ resume: { decisions } }) : { messages: [humanMessage] };
      let pendingInterrupts: HitlInterrupt[] | null = null;
      const stream = await agent.stream(input, { ...config, streamMode: 'updates' });
      for await (const updates of stream) {
        if (cancelled) {
          break;
        }
        if (updates && typeof updates === 'object' && '__interrupt__' in (updates as object)) {
          pendingInterrupts = (updates as unknown as { __interrupt__: HitlInterrupt[] }).__interrupt__;
          continue;
        }
        for (const [node, update] of Object.entries(updates as Record<string, unknown>)) {
          if (node === 'model_request' && update && typeof update === 'object' && Array.isArray((update as { messages?: unknown[] }).messages)) {
            for (const message of (update as { messages: BaseMessage[] }).messages) {
              if (AIMessage.isInstance(message)) {
                await emitAiMessage(record.sessionId, message);
              }
            }
          } else if (node === 'tools' && update && typeof update === 'object') {
            const toolsUpdate = update as { todos?: unknown; messages?: unknown[] };
            if (Array.isArray(toolsUpdate.todos) && toolsUpdate.todos.length > 0) {
              await sendPlanUpdate(record.sessionId, toolsUpdate.todos as Todo[]);
            }
            for (const message of toolsUpdate.messages ?? []) {
              await emitToolResult(record.sessionId, message as BaseMessage);
            }
          }
        }
      }
      if (cancelled) {
        return 'cancelled';
      }
      if (!pendingInterrupts) {
        break;
      }
      const resolved = await handleInterrupts(record, pendingInterrupts);
      if (resolved === null) {
        return 'cancelled';
      }
      decisions = resolved;
      if (decisions.length === 0) {
        // interrupt 却没有可裁决的动作(HITL 中间件不会产生这种形态):
        // 直接结束回合,避免把 human 消息重放进图造成死循环。
        deps.log(`[prompt] interrupt 无 actionRequests,提前结束回合: ${record.sessionId}`);
        break;
      }
      resuming = true;
    }
    return 'end_turn';
  }

  // —— session/load 回放 ——

  async function replaySession(record: SessionRecord): Promise<void> {
    const agent = getAgent(record);
    // CompiledStateGraph 的 getState 泛型按 schema 收紧,这里只需要 values;
    // 用最小结构类型绕开泛型噪声,不改变运行时行为。
    const readable = agent as unknown as { getState: (config: unknown) => Promise<{ values: unknown }> };
    const state = await readable.getState({ configurable: { thread_id: record.threadId } });
    const messages = ((state.values as { messages?: BaseMessage[] } | null | undefined) ?? {}).messages ?? [];
    for (const message of messages) {
      if (HumanMessage.isInstance(message)) {
        for (const block of messageBlocks(message)) {
          if (block.type === 'text' && block.text) {
            await send(record.sessionId, {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: block.text },
              ...(message.id ? { messageId: message.id } : {}),
            });
          }
        }
      } else if (AIMessage.isInstance(message)) {
        await emitContentChunks(record.sessionId, message, message.id);
        for (const toolCall of message.tool_calls ?? []) {
          if (!toolCall.id) {
            continue;
          }
          await emitToolCallStart(record.sessionId, toolCall.id, toolCall.name, toolCall.args as Record<string, unknown>);
          await send(record.sessionId, {
            sessionUpdate: 'tool_call_update',
            toolCallId: toolCall.id,
            status: 'completed',
          });
        }
      }
      // ToolMessage 的结果不回放:工具卡以 start+completed 呈现已足够,
      // 结果文本属于运行期细节(Python 版同样只回放 start/completed)。
    }
  }

  // —— ACP handler ——

  return {
    async initialize(params: InitializeRequest): Promise<InitializeResponse> {
      deps.log(`client connected: ${params.clientInfo?.name ?? 'unknown'} ${params.clientInfo?.version ?? ''}`);
      const protocolVersion =
        typeof params.protocolVersion === 'number' ? params.protocolVersion : Number.parseInt(String(params.protocolVersion), 10) || 1;
      return {
        protocolVersion,
        agentInfo: { name: 'panda-test-agent', title: 'Panda 测试 Agent', version: deps.version },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true },
          // #97:session 管理四件套与 handler 一一对应,不虚假声明
          sessionCapabilities: { close: {}, list: {}, delete: {}, resume: {} },
          // #99:声明 auth.logout,让 Panda 的登出按钮有真实对端。
          auth: { logout: {} },
        },
        // v1 auth(#90):声明 agent 托管登录方式。假实现,无条件成功——
        // Panda 的认证入口/记录链路以此演练。
        authMethods: [
          {
            id: 'panda-token',
            name: 'Panda 访问令牌',
            description: '测试用登录方式:点击即认证成功(假实现,不校验凭据)',
          },
        ],
      };
    },

    async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
      authenticatedMethodIds.add(params.methodId);
      deps.log(`authenticated via "${params.methodId}" (fake, always succeeds)`);
      return {};
    },

    async logout(_params: LogoutRequest): Promise<LogoutResponse> {
      const had = authenticatedMethodIds.size;
      authenticatedMethodIds.clear();
      deps.log(`logged out (${had} authenticated method record(s) cleared)`);
      return {};
    },

    async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
      const record = deps.store.create({
        modelValue: deps.models.modelsList[0]!.value,
        modeId: DEFAULT_MODE_ID,
        title: null,
        cwd: typeof params.cwd === 'string' ? params.cwd : '/',
      });
      sessionPlans.set(record.sessionId, []);
      if (Array.isArray(params.mcpServers) && params.mcpServers.length > 0) {
        // 如实记录:v1 形态我们只接收不连接(deepagents 消费 MCP 是上游事项)
        deps.log(`[session/new] 收到 ${params.mcpServers.length} 个 mcpServers 配置(接收但不连接)`);
      }
      deps.log(`created session ${record.sessionId} (thread ${record.threadId})`);
      sendAvailableCommandsAfterResponse(record.sessionId);
      return { sessionId: record.sessionId, modes: modeState(record), configOptions: configOptions(deps, record) };
    },

    async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
      const record = deps.store.get(params.sessionId);
      if (!record) {
        throw new Error(`Session not found: ${params.sessionId}`);
      }
      await replaySession(record);
      if (record.title) {
        await send(record.sessionId, { sessionUpdate: 'session_info_update', title: record.title });
      }
      deps.log(`loaded session ${record.sessionId} (thread ${record.threadId})`);
      sendAvailableCommandsAfterResponse(record.sessionId);
      return { modes: modeState(record), configOptions: configOptions(deps, record) };
    },

    async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
      const record = deps.store.get(params.sessionId);
      if (!record) {
        throw new Error(`Session not found: ${params.sessionId}`);
      }
      // 会话结束:释放这份连接里的运行态(计划草稿、命令许可记忆)。
      // SQLite 历史刻意保留 —— session/load 重放这个会话不受影响。
      sessionPlans.delete(record.sessionId);
      allowedCommandTypes.delete(record.sessionId);
      deps.log(`closed session ${record.sessionId} (runtime state released, history kept)`);
      return {};
    },

    async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
      // cursor 即行偏移(对客户端不透明即合法);小页刻意钉住客户端的
      // nextCursor 分页循环——单页返回会让那条路径永远测不到。
      const PAGE_SIZE = 2;
      const offset = params.cursor ? Number.parseInt(params.cursor, 10) : 0;
      if (!Number.isInteger(offset) || offset < 0) {
        throw new Error(`Invalid list cursor: ${String(params.cursor)}`);
      }
      const records = deps.store.list({
        cwd: params.cwd ?? undefined,
        limit: PAGE_SIZE,
        offset,
      });
      const sessions = records.map((record) => ({
        sessionId: record.sessionId,
        cwd: record.cwd,
        title: record.title,
        updatedAt: record.updatedAt,
      }));
      // 满页就可能还有下一页(下一页拉空即自然终止);不满页必然到尾。
      const nextCursor = records.length === PAGE_SIZE ? String(offset + PAGE_SIZE) : null;
      deps.log(`listed ${sessions.length} sessions (offset ${offset}, cwd ${params.cwd ?? 'any'})`);
      return { sessions, nextCursor };
    },

    async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
      const record = deps.store.get(params.sessionId);
      if (!record) {
        throw new Error(`Session not found: ${params.sessionId}`);
      }
      if (Array.isArray(params.mcpServers) && params.mcpServers.length > 0) {
        deps.log(`[session/resume] 收到 ${params.mcpServers.length} 个 mcpServers 配置(接收但不连接)`);
      }
      // 协议语义:resume 不回放历史——客户端自持 transcript,服务端只把
      // thread 上下文接回 checkpointer(threadId 在 store 里,天然跨子进程)。
      deps.store.touch(record.sessionId);
      deps.log(`resumed session ${record.sessionId} (thread ${record.threadId}, no replay)`);
      sendAvailableCommandsAfterResponse(record.sessionId);
      return { modes: modeState(record), configOptions: configOptions(deps, record) };
    },

    async deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
      const record = deps.store.get(params.sessionId);
      if (!record) {
        throw new Error(`Session not found: ${params.sessionId}`);
      }
      // 与 close 相反:delete 是抹除——元数据行、线程 checkpoints、连接内
      // 运行态一起清,之后 load 该会话必须 Session not found。
      await deps.checkpointer.deleteThread(record.threadId);
      deps.store.delete(record.sessionId);
      sessionPlans.delete(record.sessionId);
      allowedCommandTypes.delete(record.sessionId);
      deps.log(`deleted session ${record.sessionId} (thread ${record.threadId} checkpoints removed)`);
      return {};
    },

    async prompt(params: PromptRequest): Promise<PromptResponse> {
      const record = deps.store.get(params.sessionId);
      if (!record) {
        throw new Error(`Session not found: ${params.sessionId}`);
      }
      cancelled = false;

      // 首条用户文本 → 会话标题(确定性、零额外模型调用)
      if (record.title === null) {
        for (const block of params.prompt) {
          if (block.type === 'text' && typeof block.text === 'string') {
            const title = titleFromFirstUserText(block.text);
            if (title) {
              deps.store.update(record.sessionId, { title });
              record.title = title;
              await send(record.sessionId, { sessionUpdate: 'session_info_update', title });
            }
            break;
          }
        }
      }

      // #99 关键词触发流(elicitation/compaction/plan 变体):失败=通道死,
      // 回合按 cancelled 收尾,不装作正常结束。
      const promptText = params.prompt
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n');
      if (!(await runTriggerFlows(record, promptText))) {
        return { stopReason: 'cancelled' };
      }

      const stopReason = await streamTurn(record, promptToHumanMessage(params.prompt));
      const updatedAt = new Date().toISOString();
      deps.store.touch(record.sessionId);
      // #99:活跃时间随推送(sidebar 的相对时间),确定性假用量随回合上报。
      await send(record.sessionId, { sessionUpdate: 'session_info_update', updatedAt });
      await sendUsageUpdate(record.sessionId);
      deps.log(`prompt completed: ${record.sessionId} stopReason=${stopReason}`);
      return { stopReason };
    },

    async cancel(params: { sessionId: string }): Promise<void> {
      deps.log(`cancel: ${params.sessionId}`);
      cancelled = true;
    },

    async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
      const record = deps.store.get(params.sessionId);
      if (!record) {
        throw new Error(`Session not found: ${params.sessionId}`);
      }
      if (!MODES.some((mode) => mode.id === params.modeId)) {
        throw new Error(`Invalid mode: ${params.modeId}`);
      }
      deps.store.update(record.sessionId, { modeId: params.modeId });
      // #99:确认驱动之外补通知——真实 agent 常双路径,RPC 响应与
      // current_mode_update 落到同一状态,e2e 钉住这个幂等性。
      await send(record.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: params.modeId });
      return {};
    },

    async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
      const record = deps.store.get(params.sessionId);
      if (!record) {
        throw new Error(`Session not found: ${params.sessionId}`);
      }
      if (params.configId === 'mode') {
        if (typeof params.value !== 'string' || !MODES.some((mode) => mode.id === params.value)) {
          throw new Error(`Invalid mode: ${String(params.value)}`);
        }
        deps.store.update(record.sessionId, { modeId: params.value });
        // mode 走配置项同样属于模式变化:与 setSessionMode 一样补通知。
        await send(record.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: params.value });
      } else if (params.configId === 'model') {
        if (typeof params.value !== 'string' || !deps.models.instances.has(params.value)) {
          throw new Error(`Invalid model: ${String(params.value)}`);
        }
        deps.store.update(record.sessionId, { modelValue: params.value });
      } else {
        throw new Error(`Unknown config option: ${params.configId}`);
      }
      const updated = deps.store.get(record.sessionId)!;
      // #99:配置变化广播(与 set_mode 的通知同理,幂等落同一状态)。
      await send(record.sessionId, {
        sessionUpdate: 'config_option_update',
        configOptions: configOptions(deps, updated),
      });
      return { configOptions: configOptions(deps, updated) };
    },
  };
}
