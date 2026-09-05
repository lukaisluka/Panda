/// <reference types="node" />

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection, createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, client, methods } from '@agentclientprotocol/sdk';
import { createWebSocketStream } from '@agentclientprotocol/sdk/experimental/ws-client';
import {
  LiveAcpClient,
  type AgentCaps,
  type LiveClientHandlers,
} from './LiveAcpClient';
import { StreamTransport } from './transport/StreamTransport';
import { WORKSPACE_NONE_CWD } from '../workspace';
import { applyUpdate, emptySession } from '../protocol/reducer';
import type {
  AcpContentBlock,
  AcpSessionUpdate,
  PermissionRequest,
  SessionStatus,
} from '../protocol/types';

/**
 * 端到端集成测试:拉起 test-agent/ 里的 deepagents 测试 agent(真实的
 * agent 侧协议栈:LangGraph 工具执行、真实文件 diff、interrupt→权限、
 * 逐 token 流式、SQLite 会话持久化),LiveAcpClient 走真 WebSocket 连接,
 * 断言完整回合的 update 序列。与单元测试的区别:agent 端不再是剧本化的
 * SDK 假件,deepagents-acp + deepagents 全部真实运行,只有 LLM 是确定性
 * 剧本模型(scenarios.py)。
 *
 * 需要本机装有 uv;没有 uv 时整组跳过(不破坏 `pnpm test` 的零依赖运行)。
 * 可用 PANDA_TEST_AGENT_E2E=skip 强制跳过。
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PROJECT_DIR = join(REPO_ROOT, 'test-agent');

const forcedSkip = process.env.PANDA_TEST_AGENT_E2E === 'skip';
let hasUv = false;
if (!forcedSkip) {
  try {
    execFileSync('uv', ['--version'], { stdio: 'ignore' });
    hasUv = true;
  } catch {
    hasUv = false;
  }
}

type Records = {
  updates: AcpSessionUpdate[];
  statuses: SessionStatus[];
  capabilities: AgentCaps[];
  sessionIds: string[];
  sessionInfos: { sessionId: string; title?: string | null; updatedAt?: string | null }[];
  replayStarts: number;
};

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = createConnection({ host: '127.0.0.1', port }, () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`test agent 未在 ${timeoutMs}ms 内监听 ${port} 端口`));
        } else {
          setTimeout(attempt, 250);
        }
      });
    };
    attempt();
  });
}

/** Ask the OS for an unused loopback port, then release it for the test agent. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('无法分配测试端口'));
        return;
      }
      server.close((err) => (err ? reject(err) : resolve(address.port)));
    });
  });
}

describe.skipIf(!hasUv)('LiveAcpClient × deepagents 测试 agent(e2e)', () => {
  let agentProcess: ChildProcess | null = null;
  let serverLog = '';
  let sandboxDir = '';
  let stateDir = '';
  let port = 0;
  let acpClient: LiveAcpClient;
  const records: Records = {
    updates: [],
    statuses: [],
    capabilities: [],
    sessionIds: [],
    sessionInfos: [],
    replayStarts: 0,
  };

  beforeAll(async () => {
    sandboxDir = mkdtempSync(join(tmpdir(), 'panda-e2e-sandbox-'));
    stateDir = mkdtempSync(join(tmpdir(), 'panda-e2e-state-'));
    port = await findFreePort();

    agentProcess = spawn(
      'uv',
      [
        'run',
        '--project',
        PROJECT_DIR,
        'python',
        '-m',
        'panda_test_agent',
        'serve',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--sandbox-dir',
        sandboxDir,
        '--state-dir',
        stateDir,
      ],
      {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Developer-local test-agent/.env may opt into a billable real model.
        // E2E assertions must stay deterministic and never consume that key.
        env: {
          ...process.env,
          PANDA_TEST_AGENT_REAL_MODELS: '',
          PANDA_TEST_AGENT_DEFAULT_MODEL: 'fake:scripted',
        },
      },
    );
    agentProcess.stdout?.on('data', (d) => (serverLog += d));
    agentProcess.stderr?.on('data', (d) => (serverLog += d));

    try {
      await waitForPort(port, 180_000);
    } catch (err) {
      console.error('test agent 启动日志:\n' + serverLog);
      throw err;
    }

    const handlers: LiveClientHandlers = {
      onUpdate: (update) => {
        records.updates.push(update);
        // Status rides the update stream (#55).
        if (update.sessionUpdate === 'status_changed') records.statuses.push(update.status);
      },
      onSessionModes: () => {},
      onSessionConfigOptions: () => {},
      onConnected: () => {},
      onSessionId: (sessionId) => records.sessionIds.push(sessionId),
      onDisconnected: () => {},
      onAuthChallenge: () => {},
      onAuthElicitation: () => {},
      onCapabilities: (capabilities) => records.capabilities.push(capabilities),
      onSessions: () => {},
      onSessionInfo: (sessionId, info) => records.sessionInfos.push({ sessionId, ...info }),
      onReplayStart: () => records.replayStarts++,
      onSessionDeleted: () => {},
      onSessionSwitchStage: () => {},
      onSessionSwitchCommit: () => {},
      onSessionSwitchRollback: () => {},
    };
    acpClient = new LiveAcpClient(handlers);
    await acpClient.connect(new StreamTransport(createWebSocketStream(`ws://127.0.0.1:${port}/acp`)), '/tmp/project');
  }, 180_000);

  afterAll(async () => {
    acpClient?.disconnect();
    if (agentProcess?.pid) {
      try {
        process.kill(-agentProcess.pid, 'SIGTERM');
        await new Promise((r) => setTimeout(r, 500));
        if (agentProcess.exitCode === null) process.kill(-agentProcess.pid, 'SIGKILL');
      } catch {
        /* 进程组可能已退出 */
      }
    }
    rmSync(sandboxDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  /** 未决权限请求:按事件流时序折叠(requested 置入、resolved 移除)——同一 id 被 agent 重问时重新挂起。 */
  const pendingPermissionRequests = () => {
    const pending = new Map<string, PermissionRequest>();
    for (const update of records.updates) {
      if (update.sessionUpdate === 'permission_requested') {
        pending.set(update.request.toolCallId, update.request);
      } else if (update.sessionUpdate === 'permission_resolved') {
        pending.delete(update.toolCallId);
      }
    }
    return [...pending.values()];
  };

  /** 依次批准 ask 模式下的每个权限请求,直到回合结束。 */
  const approveAllPending = async (expected: number) => {
    for (let i = 0; i < expected; i++) {
      await waitFor(
        () => pendingPermissionRequests().length > 0,
        30_000,
        `第 ${i + 1}/${expected} 个权限请求`,
      );
      const pending = pendingPermissionRequests();
      acpClient.resolvePermission(pending[0]!.toolCallId, 'allow_once');
    }
  };

  it('声明图片与 load 能力,不伪装 session 管理能力,并支持模式切换', async () => {
    expect(records.capabilities).toEqual([
      { image: true, loadSession: true, list: false, resume: false, delete: false },
    ]);

    const connection = client({ name: 'panda-e2e-mode-check' }).connect(
      createWebSocketStream(`ws://127.0.0.1:${port}/acp`),
    );
    try {
      const initialized = await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'panda-e2e-mode-check', version: '0.0.0' },
      });
      expect(initialized.agentCapabilities?.promptCapabilities?.image).toBe(true);
      expect(initialized.agentCapabilities?.loadSession).toBe(true);
      expect(initialized.agentCapabilities?.sessionCapabilities).toBeUndefined();

      const session = await connection.agent.request(methods.agent.session.new, {
        cwd: '/tmp/project',
        mcpServers: [],
      });
      expect(session.modes?.currentModeId).toBe('ask_before_edits');

      const switched = await connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId: 'mode',
        value: 'accept_everything',
      });
      const mode = switched.configOptions.find((option) => option.id === 'mode');
      expect(mode && mode.type === 'select' ? mode.currentValue : null).toBe(
        'accept_everything',
      );
    } finally {
      connection.close();
    }
  });

  /** Folds a slice of the recorded update stream into a session document. */
  const foldSlice = (from: number) =>
    records.updates.slice(from).reduce((doc, update) => applyUpdate(doc, update), emptySession());
  const userBlocks = (from: number): AcpContentBlock[][] =>
    foldSlice(from).turns.flatMap((turn) =>
      turn.blocks.flatMap((block) => (block.kind === 'user_message' ? [block.content] : [])),
    );

  it(
    '完整回合:计划→读→改(真实 diff)→执行→总结,权限逐个批准',
    { timeout: 90_000 },
    async () => {
      await acpClient.newSession('/tmp/project');

      const turn = acpClient.send([{ type: 'text', text: '重构 auth 校验' }]);
      // ask_before_edits 模式下剧本第 1 轮会触发 3 个权限:
      // write_todos → edit_file → execute
      await approveAllPending(3);
      await turn;

      // echo 对账(issue #15):同一 prompt 只渲染一条用户消息
      const turnStart = records.updates.findIndex((u) => u.sessionUpdate === 'user_message');
      const sent = userBlocks(turnStart).flat();
      expect(sent.filter((t) => t.type === 'text' && t.text === '重构 auth 校验')).toHaveLength(1);

      // 回合结束回到 idle
      expect(records.statuses.at(-1)).toBe('idle');
      expect(records.sessionInfos).toContainEqual({
        sessionId: records.sessionIds.at(-1),
        title: '重构 auth 校验',
      });

      // 思考块与消息块都真实流过
      const thoughts = records.updates.filter((u) => u.sessionUpdate === 'agent_thought_chunk');
      const messages = records.updates.filter((u) => u.sessionUpdate === 'agent_message_chunk');
      expect(thoughts.length).toBeGreaterThan(10);
      expect(messages.length).toBeGreaterThan(10);
      const joined = messages
        .map((u) => (u.sessionUpdate === 'agent_message_chunk' ? u.content : null))
        .filter((c): c is { type: 'text'; text: string } => c?.type === 'text')
        .map((c) => c.text)
        .join('');
      expect(joined).toContain('重构完成');

      // 计划卡:write_todos → plan update
      const plan = records.updates.find((u) => u.sessionUpdate === 'plan');
      expect(plan && plan.sessionUpdate === 'plan' ? plan.entries : []).toHaveLength(3);

      // 工具卡:read / edit / execute 三种 kind 都出现
      const toolCalls = records.updates.filter(
        (u): u is Extract<AcpSessionUpdate, { sessionUpdate: 'tool_call' }> =>
          u.sessionUpdate === 'tool_call',
      );
      const kinds = new Set(toolCalls.map((u) => u.kind));
      for (const kind of ['read', 'edit', 'execute']) {
        expect(kinds, `工具卡缺少 kind=${kind}: ${[...kinds]}`).toContain(kind);
      }

      // edit_file 的 diff 真实送达(来自沙箱里的真实文件改动)
      const diffs = records.updates.flatMap((u) =>
        u.sessionUpdate === 'tool_call_update' ? (u.content ?? []) : [],
      );
      const editDiff = diffs.find(
        (c): c is Extract<typeof c, { type: 'diff' }> => c.type === 'diff',
      );
      expect(editDiff?.path).toBe('/auth.ts');
      expect(editDiff?.newText).toContain('!validateSession(session)');

      // 沙箱里的文件被 agent 真实修改(工具执行不是演的)
      expect(readFileSync(join(sandboxDir, 'auth.ts'), 'utf8')).toContain(
        'if (!validateSession(session)) {',
      );

      // 权限选项是 Panda 认识的四种 kind 之一
      const firstRequest = records.updates.find(
        (u): u is Extract<typeof u, { sessionUpdate: 'permission_requested' }> =>
          u.sessionUpdate === 'permission_requested',
      );
      expect(firstRequest?.request.options.map((o) => o.kind)).toContain('allow_once');
    },
  );

  it(
    '第二轮固定回复,验证追加消息',
    { timeout: 60_000 },
    async () => {
      const messageCountBefore = records.updates.filter(
        (u) => u.sessionUpdate === 'agent_message_chunk',
      ).length;
      await acpClient.send([{ type: 'text', text: '收到请回复' }]);

      const newMessages = records.updates
        .filter((u) => u.sessionUpdate === 'agent_message_chunk')
        .slice(messageCountBefore);
      expect(newMessages.length).toBeGreaterThan(0);
      const joined = newMessages
        .map((u) =>
          u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text'
            ? u.content.text
            : '',
        )
        .join('');
      expect(joined).toContain('追加消息');
      expect(records.statuses.at(-1)).toBe('idle');
    },
  );

  it('断开后由新 stdio 子进程通过 session/load 回放持久化会话', async () => {
    const sessionId = records.sessionIds.at(-1);
    expect(sessionId).toBeTruthy();
    const updateCountBefore = records.updates.length;

    acpClient.disconnect();
    await acpClient.connect(
      new StreamTransport(createWebSocketStream(`ws://127.0.0.1:${port}/acp`)),
      '/tmp/project',
      { sessionId: sessionId! },
    );

    expect(records.replayStarts).toBe(1);
    expect(records.sessionIds.at(-1)).toBe(sessionId);
    expect(records.sessionInfos.at(-1)).toEqual({
      sessionId,
      title: '重构 auth 校验',
    });
    expect(records.updates.length).toBeGreaterThan(updateCountBefore);
    expect(
      records.updates
        .slice(updateCountBefore)
        .some((u) => u.sessionUpdate === 'agent_message_chunk'),
    ).toBe(true);
    // echo 对账(issue #15):session/load 重放后历史里该 prompt 只有一条用户消息
    const replayed = userBlocks(updateCountBefore).flat().filter(
      (t) => t.type === 'text' && t.text === '重构 auth 校验',
    );
    expect(replayed).toHaveLength(1);
  });

  it(
    '权限挂起时 cancel:回合立即终止,agent 存活',
    { timeout: 90_000 },
    async () => {
      await acpClient.newSession('/tmp/project');
      const turn = acpClient.send([{ type: 'text', text: '重构 auth 校验' }]);
      // 等第一个权限请求(剧本会停在 write_todos 的 interrupt 上)
      await waitFor(
        () => pendingPermissionRequests().length > 0,
        30_000,
        'cancel 用例的权限请求',
      );
      // 回合明确卡在权限上时取消——确定性的取消时机
      acpClient.cancel();
      await turn;
      expect(records.statuses.at(-1)).toBe('idle');

      // agent 子进程没有死:新会话还能完整跑一轮
      const planCountBefore = records.updates.filter((u) => u.sessionUpdate === 'plan').length;
      await acpClient.newSession('/tmp/project');
      const turn2 = acpClient.send([{ type: 'text', text: '重构 auth 校验' }]);
      await approveAllPending(3);
      await turn2;
      expect(
        records.updates.filter((u) => u.sessionUpdate === 'plan').length,
      ).toBeGreaterThan(planCountBefore);
    },
  );

  it(
    '无工作区会话:cwd="/" 建会话、完整收发,并按同一 cwd 恢复(issue #23, ADR 0005)',
    { timeout: 90_000 },
    async () => {
      await acpClient.newSession(WORKSPACE_NONE_CWD);
      const sessionId = records.sessionIds.at(-1)!;
      expect(sessionId).toBeTruthy();
      const marker = records.updates.length;

      const turn = acpClient.send([{ type: 'text', text: '重构 auth 校验' }]);
      await approveAllPending(3);
      await turn;
      expect(records.statuses.at(-1)).toBe('idle');

      // 完整收发:本回合的总结文字与真实 diff 都流过——test agent 把文件后端
      // 钉在沙箱目录,协议 cwd 不参与路径解析,`/` 会话一样能干活。
      const slice = records.updates.slice(marker);
      const joined = slice
        .map((u) => (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text' ? u.content.text : ''))
        .join('');
      expect(joined).toContain('重构完成');
      const diffs = slice.flatMap((u) =>
        u.sessionUpdate === 'tool_call_update' ? (u.content ?? []) : [],
      );
      expect(diffs.some((c) => c.type === 'diff' && c.path === '/auth.ts')).toBe(true);

      // 恢复必须逐字使用同一 cwd(deepagents-acp 的 session/load 相等校验):
      // 重连 resume 该会话,`/` 原样发送,重放成功。
      acpClient.disconnect();
      await acpClient.connect(
        new StreamTransport(createWebSocketStream(`ws://127.0.0.1:${port}/acp`)),
        WORKSPACE_NONE_CWD,
        { sessionId },
      );
      expect(records.replayStarts).toBe(2);
      expect(records.sessionIds.at(-1)).toBe(sessionId);
    },
  );
});
