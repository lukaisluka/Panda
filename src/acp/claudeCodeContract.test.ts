/// <reference types="node" />

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { agent, methods, type AnyMessage, type SessionNotification, type Stream } from '@agentclientprotocol/sdk';
import { LiveAcpClient, type AgentCaps, type LiveClientHandlers } from './LiveAcpClient';
import { StreamTransport } from './transport/StreamTransport';
import { toAcpUpdates } from './wire';
import { applyUpdate, emptySession } from '../protocol/reducer';
import type { AcpConfigOption, AcpSessionModeState, AcpSessionUpdate, Block, ElicitationRequest, SessionDocument } from '../protocol/types';

/**
 * 契约测试(#154 层 1):把真实 Claude Code 适配器
 * (`@agentclientprotocol/claude-agent-acp`)一次实跑的报文回放进 Panda 的
 * 解析与折叠管线。fixtures 由 `pnpm --filter panda-test-agent
 * record:claude-code` 录制(一次性、花几分钱真实 token),入库后 CI 永久
 * 回放 —— 适配器升级导致的协议漂移表现为 fixture diff + 本文件变红。
 *
 * 与 test-agent e2e 的分工:那边验证「我们自研的 agent 栈」端到端正确;
 * 这里验证「第三方真实报文形状」能被 wire 解释(toAcpUpdates)、文档折叠
 * (applyUpdate)与客户端管线(LiveAcpClient)全量消化。
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE_DIR = join(REPO_ROOT, 'test-agent', 'fixtures', 'claude-code');

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as Record<string, unknown>;

const hasFixtures = existsSync(join(FIXTURE_DIR, '03-turn.json'));

/** Folds the recorded turn's wire notifications through the full pipeline. */
function foldRecordedTurn(doc: SessionDocument = emptySession()): SessionDocument {
  // Fixtures store full JSON-RPC lines; the pipeline consumes the params.
  const lines = fixture('03-turn.json').updates as { method?: string; params?: SessionNotification }[];
  for (const line of lines) {
    if (line.method !== 'session/update' || !line.params?.update) continue;
    for (const mapped of toAcpUpdates(line.params)) {
      doc = applyUpdate(doc, mapped);
    }
  }
  return doc;
}

/** Message-level stream pair (same construction as LiveAcpClient.test.ts). */
function streamPair(): { clientStream: Stream; serverStream: Stream } {
  const c2s = new TransformStream<AnyMessage>();
  const s2c = new TransformStream<AnyMessage>();
  return {
    clientStream: { writable: c2s.writable, readable: s2c.readable },
    serverStream: { writable: s2c.writable, readable: c2s.readable },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe.skipIf(!hasFixtures)('claude-agent-acp 真实报文契约(#154 回放)', () => {
  describe('真实回合 update 流:wire 解释 + reducer 折叠', () => {
    const doc = foldRecordedTurn();
    const blocks = doc.turns.flatMap((turn) => turn.blocks as Block[]);

    it('真实回合的全部 83 条通知都被映射,零条落入 unsupported 兜底', () => {
      // claude 只发送 Panda 已映射的 sessionUpdate 类型(thought/message/
      // tool_call/usage/available_commands)。数字钉死:适配器新增发送类型
      // 时这里先红,提醒补映射而不是静默吞进兜底。
      expect(blocks.filter((b) => b.kind === 'unsupported').length).toBe(0);
    });

    it('agent_message 块组装出非空正文', () => {
      const messages = blocks.filter((b): b is Extract<Block, { kind: 'agent_message' }> => b.kind === 'agent_message');
      expect(messages.length).toBeGreaterThan(0);
      const text = messages
        .flatMap((m) => m.parts)
        .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('');
      expect(text.length).toBeGreaterThan(20);
    });

    it('thought 块存在(agent_thought_chunk → thought)', () => {
      expect(blocks.some((b) => b.kind === 'thought')).toBe(true);
    });

    it('工具卡全部收敛到终态(claude 的 Edit/Read 调用)', () => {
      const tools = blocks.filter((b): b is Extract<Block, { kind: 'tool_call' }> => b.kind === 'tool_call');
      expect(tools.length).toBeGreaterThanOrEqual(2);
      // claude 的工具调用携带 v1 工具种类:Read/Edit 的 kind 即 'read'/'edit'。
      expect(tools.map((t) => t.call.kind)).toEqual(expect.arrayContaining(['read', 'edit']));
      for (const tool of tools) {
        expect(['completed', 'failed', 'cancelled']).toContain(tool.call.status);
        expect(tool.call.title.length).toBeGreaterThan(0);
      }
    });

    it('usage 快照被折叠(usage_update)', () => {
      expect(doc.usage).not.toBeNull();
      expect(doc.usage!.used).toBeGreaterThanOrEqual(0);
      expect(doc.usage!.size).toBeGreaterThanOrEqual(0);
    });

    it('斜杠命令白名单接受真实 available_commands_update', () => {
      expect(doc.availableCommands.length).toBeGreaterThan(0);
      for (const command of doc.availableCommands) {
        expect(typeof command.name).toBe('string');
        expect(typeof command.description).toBe('string');
      }
    });
  });

  describe('LiveAcpClient 管线回放(真实响应驱动)', () => {
    it('initialize 能力、真实回合、session/list、session/load 回放、session/delete', { timeout: 20_000 }, async () => {
      const initializeResult = fixture('01-initialize.json').result;
      const newSessionResult = fixture('02-session-new.json').result as { sessionId: string; modes?: unknown; configOptions?: unknown };
      const turn = fixture('03-turn.json') as {
        updates: { method?: string; params?: SessionNotification }[];
        promptResponse: { result: { stopReason: string } };
      };
      const listResult = fixture('04-session-list.json').result as {
        sessions: { sessionId: string; cwd: string; title: string | null; updatedAt: string | null }[];
      };
      const load = fixture('05-session-load.json') as {
        loadResponse: { result: Record<string, unknown> };
        replayedUpdates: { method?: string; params?: SessionNotification }[];
      };

      const capabilities: AgentCaps[] = [];
      const connected: { agentName: string; protocolVersion: number }[] = [];
      const updates: AcpSessionUpdate[] = [];
      const sessionIds: string[] = [];
      const modes: (AcpSessionModeState | null)[] = [];
      const configOptions: (AcpConfigOption[] | null)[] = [];
      const sessions: unknown[][] = [];
      const deletedSessions: string[] = [];
      const switchCommits = { count: 0 };
      const switchRollbacks: string[] = [];

      const { clientStream, serverStream } = streamPair();
      agent({ name: 'claude-replay' })
        .onRequest(methods.agent.initialize, async () => initializeResult as never)
        .onRequest(methods.agent.session.new, async () => newSessionResult as never)
        .onRequest(methods.agent.session.list, async () => listResult as never)
        .onRequest(methods.agent.session.load, async (ctx) => {
          for (const line of load.replayedUpdates) {
            if (line.method !== 'session/update' || !line.params?.update) continue;
            await ctx.client.notify(methods.client.session.update, {
              sessionId: ctx.params.sessionId,
              update: line.params.update,
            });
          }
          return load.loadResponse.result as never;
        })
        .onRequest(methods.agent.session.delete, () => ({}))
        .onRequest(methods.agent.session.prompt, async (ctx) => {
          for (const line of turn.updates) {
            if (line.method !== 'session/update' || !line.params?.update) continue;
            await ctx.client.notify(methods.client.session.update, {
              sessionId: ctx.params.sessionId,
              update: line.params.update,
            });
          }
          return { stopReason: turn.promptResponse.result.stopReason } as never;
        })
        .connect(serverStream);

      const noop = () => {};
      const handlers: LiveClientHandlers = {
        onUpdate: (update) => updates.push(update),
        onConnected: (info) => connected.push(info),
        onSessionId: (sessionId) => sessionIds.push(sessionId),
        onSessionModes: (m) => modes.push(m),
        onSessionConfigOptions: (o) => configOptions.push(o),
        onDisconnected: noop,
        onAuthChallenge: noop,
        onAuthElicitation: (_request: ElicitationRequest | null) => noop(),
        onCapabilities: (caps) => capabilities.push(caps),
        onAuthMethods: noop,
        onAuthenticated: noop,
        onSessions: (entries) => sessions.push(entries),
        onSessionInfo: noop,
        onReplayStart: noop,
        onSessionDeleted: (sessionId) => deletedSessions.push(sessionId),
        onSessionSwitchStage: noop,
        onSessionSwitchCommit: () => {
          switchCommits.count += 1;
        },
        onSessionSwitchRollback: (reason) => switchRollbacks.push(reason),
      };
      const acpClient = new LiveAcpClient(handlers);
      await acpClient.connect(new StreamTransport(clientStream), '/tmp/project');

      // 真实 initialize(claude-agent-acp 0.75.x):list/resume/delete/close
      // 全量 session 能力 + image + loadSession → Panda 能力矩阵全绿。
      expect(capabilities[0]).toEqual({ image: true, loadSession: true, list: true, resume: true, delete: true });
      // 客户端展示 agentInfo.title(claude 的真实值)。
      expect(connected[0]?.agentName).toBe('Claude Agent');

      // 真实 session/new 响应携带 modes/configOptions。
      await waitFor(() => sessionIds.length > 0, 2000, 'session/new');
      expect(sessionIds[0]).toBe(newSessionResult.sessionId);
      expect(modes[0]?.currentModeId).toBeTruthy();

      // 真实 session/list 响应 → 侧栏条目形状。
      await waitFor(() => sessions.length > 0, 2000, 'session/list');
      const first = (sessions[0] as typeof listResult.sessions)[0];
      expect(first?.cwd).toBe('/private/tmp/panda-cc-record');
      expect(typeof first?.sessionId).toBe('string');

      // 真实回合:send() 后 fake agent 按录制的原序推全部通知再以
      // end_turn 收尾。end_turn 是「无事发生的结束」,客户端不写
      // turn_notice(设计),收敛体现为状态回到 idle + 正文/思考块到达。
      await acpClient.send([{ type: 'text', text: 'replay the recorded turn' }]);
      await waitFor(
        () => updates.some((u) => u.sessionUpdate === 'status_changed' && u.status === 'idle'),
        10_000,
        'turn settle (idle)',
      );
      expect(updates.some((u) => u.sessionUpdate === 'agent_message_chunk')).toBe(true);
      expect(updates.some((u) => u.sessionUpdate === 'unsupported')).toBe(false);

      // 真实 session/load 回放流:9 条重放通知经 onUpdate 重建历史,
      // 事务以 commit 收尾(user_message 是 replay 回合独有的块 —— 提示
      // 回合本身不回显用户消息,能证明流来自 load 而非残留)。
      const before = updates.length;
      await acpClient.loadSession(newSessionResult.sessionId, '/tmp/project');
      await waitFor(() => updates.length > before, 5000, 'replay updates');
      expect(updates.some((u) => u.sessionUpdate === 'user_message')).toBe(true);
      expect(switchCommits.count).toBe(1);
      expect(switchRollbacks).toEqual([]);

      // 真实 session/delete 响应为空对象 —— 客户端视为成功并广播删除。
      await acpClient.deleteSession(newSessionResult.sessionId);
      expect(deletedSessions).toEqual([newSessionResult.sessionId]);

      acpClient.disconnect();
    });
  });
});
