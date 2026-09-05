/**
 * deepagents 装配:三档权限模式 + 会话级 agent 工厂。
 *
 * 与官方 demo 一致的三档模式;默认 ask_before_edits——测试 agent 的职责
 * 就是把权限卡路径暴露出来,让 Panda 的 request_permission → resolve 流程
 * 可测。backend 固定指向沙箱目录——测试 agent 忽略客户端传来的 cwd,
 * 保证剧本的 read/edit/execute 都落在种子重置过的沙箱里,结果可复现。
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { todoListMiddleware } from 'langchain';
import { createDeepAgent, LocalShellBackend } from 'deepagents';

export interface SessionMode {
  id: string;
  name: string;
  description: string;
}

export const MODES: SessionMode[] = [
  {
    id: 'ask_before_edits',
    name: 'Ask before edits',
    description: '每一步写入/编辑/执行都要经过权限确认',
  },
  {
    id: 'accept_edits',
    name: 'Accept edits',
    description: '自动接受文件改动,仅命令执行与计划需要确认',
  },
  {
    id: 'accept_everything',
    name: 'Accept everything',
    description: '全自动,不请求任何权限',
  },
];

export const DEFAULT_MODE_ID = 'ask_before_edits';

type InterruptTier = Record<string, { allowedDecisions: ['approve', 'reject'] }>;

const APPROVE_REJECT = { allowedDecisions: ['approve', 'reject'] as ['approve', 'reject'] };

export const INTERRUPT_CONFIGS: Record<string, InterruptTier> = {
  ask_before_edits: {
    edit_file: APPROVE_REJECT,
    write_file: APPROVE_REJECT,
    write_todos: APPROVE_REJECT,
    execute: APPROVE_REJECT,
  },
  accept_edits: {
    write_todos: APPROVE_REJECT,
    execute: APPROVE_REJECT,
  },
  accept_everything: {},
};

export function makeBackend(sandboxDir: string): LocalShellBackend {
  // virtualMode: 剧本里的 `/auth.ts` 等虚拟绝对路径映射到沙箱目录内;
  // inheritEnv: execute 需要 PATH 等基础环境(与 Python 版行为一致)。
  return new LocalShellBackend({ rootDir: sandboxDir, virtualMode: true, inheritEnv: true });
}

export function buildDeepAgent(
  model: BaseChatModel,
  modeId: string,
  backend: LocalShellBackend,
  checkpointer: BaseCheckpointSaver,
) {
  const interruptOn = INTERRUPT_CONFIGS[modeId];
  if (interruptOn === undefined) {
    throw new Error(`未注册的模式: ${modeId},可用模式: ${Object.keys(INTERRUPT_CONFIGS).join(', ')}`);
  }
  return createDeepAgent({
    model,
    // deepagents 1.13 的默认工具集不含 write_todos。显式装配
    // TodoListMiddleware 才能让剧本的计划步骤真实执行并产生 plan update。
    middleware: [todoListMiddleware()],
    backend,
    interruptOn,
    checkpointer,
  });
}
