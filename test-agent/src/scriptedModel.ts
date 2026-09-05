/**
 * 确定性剧本模型:按 (用户轮次, 步骤) 查剧本表返回固定响应。
 *
 * deepagents 的工具循环消费模型的流式 tool_call_chunks(工具卡/计划/diff
 * 等 update 都由它驱动),因此 `_stream` 必须实现。思考块使用
 * `{type: "reasoning", reasoning}` 内容块,由 ACP 壳映射为
 * agent_thought_chunk。模型完全无内部状态:每次调用的返回值只由收到的
 * 消息列表决定(HumanMessage 个数 = 用户轮次,其后 AIMessage 个数 = 步骤
 * 序号),因此同一剧本永远得到同一结果,适合回归断言。
 */

import type { BaseChatModelParams, BindToolsInput } from '@langchain/core/language_models/chat_models';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { scriptedStep, type Step, type ToolCall } from './scenarios';

// 中文没有空格,按单字流出才像真实模型的增量输出;非中文字符按词流出
const WORD_RE = /[\u4e00-\u9fff]|[^\u4e00-\u9fff\s]+\s*/g;

interface ToolCallChunkPayload {
  name: string;
  args: string;
  id: string;
  index: number;
  type: 'tool_call_chunk';
}

/** 从消息列表算出 (用户轮次, 本轮步骤序号)。 */
export function locate(messages: BaseMessage[]): { userTurn: number; stepIndex: number } {
  // HumanMessage 个数即轮次(系统消息不计);最后一条 HumanMessage 之后
  // 已出现的 AIMessage 个数即步骤序号——LangGraph 的工具循环每转一圈
  // 会追加一条 AIMessage,下一次模型调用就能看到它。
  //
  // 用 isInstance 而不是 `.type` 判定:core 1.x 里 AIMessageChunk 是
  // AIMessage 子类,但 type 是 "AIMessageChunk" 而非 "ai"。
  let userTurn = 0;
  for (const message of messages) {
    if (HumanMessage.isInstance(message)) userTurn += 1;
  }
  let stepIndex = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (HumanMessage.isInstance(message)) break;
    if (AIMessage.isInstance(message)) stepIndex += 1;
  }
  return { userTurn, stepIndex };
}

function toolCallIds(turn: number, stepIndex: number): (index: number) => string {
  return (index: number) => `call_t${turn}s${stepIndex}c${index}`;
}

function buildStepMessage(s: Step, turn: number, stepIndex: number): AIMessageChunk {
  const ids = toolCallIds(turn, stepIndex);
  const content: AIMessageChunk['content'] = [];
  if (s.reasoning) {
    content.push({ type: 'reasoning', reasoning: s.reasoning });
  }
  if (s.text) {
    content.push({ type: 'text', text: s.text });
  }
  return new AIMessageChunk({
    content: content.length > 0 ? content : '',
    tool_calls: s.toolCalls.map((call: ToolCall, i: number) => ({
      name: call.name,
      args: call.args,
      id: ids(i),
      type: 'tool_call' as const,
    })),
  });
}

/** 直接构造 tool_call_chunks:显式给出 index,避免多工具调用共用 undefined 下标。 */
function toolCallChunksPayload(
  calls: ToolCall[],
  turn: number,
  stepIndex: number,
): ToolCallChunkPayload[] {
  const ids = toolCallIds(turn, stepIndex);
  return calls.map((call, i) => ({
    name: call.name,
    args: JSON.stringify(call.args),
    id: ids(i),
    index: i,
    type: 'tool_call_chunk' as const,
  }));
}

function splitWords(text: string): string[] {
  return text.match(WORD_RE) ?? [];
}

/** 播放 `scenarios.ts` 剧本的假模型,是本测试 agent 的默认大脑。 */
export class ScriptedChatModel extends BaseChatModel {
  constructor(params: BaseChatModelParams = {}) {
    super(params);
  }

  _llmType(): string {
    return 'scripted-test-model';
  }

  /** deepagents 装配时会 bindTools;剧本模型忽略工具清单,返回自身。 */
  override bindTools(_tools: BindToolsInput[]): this {
    return this;
  }

  override async _generate(
    messages: BaseMessage[],
    _options: unknown,
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const { userTurn, stepIndex } = locate(messages);
    const s = scriptedStep(userTurn, stepIndex);
    const message = buildStepMessage(s, userTurn, stepIndex);
    if (runManager) {
      for (const piece of splitWords(s.text ?? '')) {
        await runManager.handleLLMNewToken(piece);
      }
    }
    return {
      generations: [new ChatGenerationChunk({ message, text: s.text ?? '' })],
    };
  }

  /** core 1.x 的流式入口是 _streamResponseChunks(deepagents 工具循环走这里)。 */
  override async *_streamResponseChunks(
    messages: BaseMessage[],
    _options: unknown,
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const { userTurn, stepIndex } = locate(messages);
    const s = scriptedStep(userTurn, stepIndex);

    const emit = (message: AIMessageChunk, token = ''): ChatGenerationChunk => {
      const chunk = new ChatGenerationChunk({ message, text: token });
      if (runManager) {
        runManager.handleLLMNewToken(token);
      }
      return chunk;
    };

    // 逐词流出思考块,让 agent_thought_chunk 的增量渲染路径真实工作。
    if (s.reasoning) {
      for (const piece of splitWords(s.reasoning)) {
        yield emit(
          new AIMessageChunk({ content: [{ type: 'reasoning', reasoning: piece }] }),
          piece,
        );
      }
    }
    // tool_call_chunks 整条一次发出,ACP 壳据此发出工具卡 start update。
    if (s.toolCalls.length > 0) {
      yield emit(
        new AIMessageChunk({
          content: '',
          tool_call_chunks: toolCallChunksPayload(s.toolCalls, userTurn, stepIndex),
        }),
      );
    }
    if (s.text) {
      for (const piece of splitWords(s.text)) {
        yield emit(new AIMessageChunk({ content: piece }), piece);
      }
    }
  }
}
