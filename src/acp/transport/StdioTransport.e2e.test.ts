/// <reference types="node" />

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LiveAcpClient, type LiveClientHandlers } from '../LiveAcpClient';
import { StdioTransport, type StdioChildProcess, type StdioSpawn } from './StdioTransport';
import type { AcpSessionUpdate, SessionStatus } from '../../protocol/types';

/**
 * stdio 传输端到端:与 LiveAcpClient.e2e 同一真实 agent 栈(test-agent 的
 * deepagents + 确定性剧本模型),但连接不走 WebSocket 桥,而是经
 * StdioTransport 直接 spawn `main.ts stdio` 子进程、走生产同款 NDJSON
 * framing(自研行切分 + 非 JSON 行丢弃)。这是桌面壳(PR 3)前的传输层
 * 验收:字节进出、生命周期、断开杀进程。
 *
 * 依赖与跳过条件与 WS e2e 一致:test-agent 依赖未装时整组跳过,
 * PANDA_TEST_AGENT_E2E=skip 强制跳过。
 */

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const PROJECT_DIR = join(REPO_ROOT, 'test-agent');

const forcedSkip = process.env.PANDA_TEST_AGENT_E2E === 'skip';
const hasAgentDeps = !forcedSkip && existsSync(join(PROJECT_DIR, 'node_modules'));

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Node 参考实现 of the StdioSpawn seam: a real `child_process.spawn` behind
 * the transport's contract. The desktop host (PR 3) implements the same seam
 * over Tauri process commands; this file proves the transport side against a
 * living child. kill 走 SIGTERM→3s→SIGKILL(镜像 test-agent serve 桥)。
 */
function nodeStdioSpawn(onStderr: (chunk: string) => void, env: NodeJS.ProcessEnv): StdioSpawn {
  return ({ program, args, cwd }) =>
    new Promise<StdioChildProcess>((resolve, reject) => {
      const child: ChildProcess = spawn(program, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      child.once('error', reject); // ENOENT 等 spawn 失败 = 连接失败
      if (!child.stdin || !child.stdout || !child.stderr) {
        reject(new Error('stdio pipes unavailable'));
        return;
      }
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', onStderr);
      let exited = false;
      const exitHandlers: Array<(code: number | null) => void> = [];
      child.once('exit', (code) => {
        exited = true;
        for (const handler of exitHandlers) handler(code);
      });
      resolve({
        write: (data) =>
          new Promise<void>((resolveWrite, rejectWrite) => {
            child.stdin!.write(data, (err) => (err ? rejectWrite(err) : resolveWrite()));
          }),
        onStdoutChunk: (handler) => {
          child.stdout!.on('data', (chunk: Buffer) => handler(new Uint8Array(chunk)));
        },
        onExit: (handler) => exitHandlers.push(handler),
        kill: () =>
          new Promise<void>((resolveKill) => {
            const done = () => resolveKill();
            if (exited || child.exitCode !== null || child.signalCode !== null) {
              done();
              return;
            }
            child.once('exit', done);
            child.kill('SIGTERM');
            setTimeout(() => {
              if (!exited) child.kill('SIGKILL');
            }, 3_000).unref();
          }),
      });
    });
}

describe.skipIf(!hasAgentDeps)('StdioTransport × deepagents 测试 agent(e2e)', () => {
  let sandboxDir = '';
  let stateDir = '';
  let agentLog = '';
  let acpClient: LiveAcpClient;
  let transport: StdioTransport;
  let childExited: number | null | undefined; // undefined = still running
  const updates: AcpSessionUpdate[] = [];
  const statuses: SessionStatus[] = [];
  const sessionIds: string[] = [];

  beforeAll(async () => {
    // 沙箱路径必须"不存在":stdio 模式只在目录缺失时播种种子工程(剧本
    // 第 1 轮要真实读改 /auth.ts)。state 目录则每次全新。
    sandboxDir = join(tmpdir(), `panda-stdio-sandbox-${globalThis.crypto.randomUUID()}`);
    stateDir = mkdtempSync(join(tmpdir(), 'panda-stdio-state-'));
    const spawnImpl = nodeStdioSpawn(
      (chunk) => (agentLog += chunk),
      // 与 WS e2e 同一克制:本地 .env 可能启用计费真模型,必须空覆盖。
      {
        ...process.env,
        PANDA_TEST_AGENT_REAL_MODELS: '',
        PANDA_TEST_AGENT_DEFAULT_MODEL: 'fake:scripted',
      },
    );
    transport = new StdioTransport(
      {
        program: process.execPath,
        args: [
          '--import',
          'tsx',
          join(PROJECT_DIR, 'src', 'main.ts'),
          'stdio',
          '--sandbox-dir',
          sandboxDir,
          '--state-dir',
          stateDir,
        ],
        cwd: PROJECT_DIR,
      },
      spawnImpl,
    );
    transport.onClose(() => {
      // onClose settles on child exit — the orphan check's signal.
      if (childExited === undefined) childExited = null;
    });

    const handlers: LiveClientHandlers = {
      onUpdate: (update) => {
        updates.push(update);
        if (update.sessionUpdate === 'status_changed') statuses.push(update.status);
      },
      onSessionModes: () => {},
      onSessionConfigOptions: () => {},
      onConnected: () => {},
      onSessionId: (sessionId) => sessionIds.push(sessionId),
      onDisconnected: () => {},
      onAuthChallenge: () => {},
      onAuthElicitation: () => {},
      onAuthMethods: () => {},
      onAuthenticated: () => {},
      onCapabilities: () => {},
      onSessions: () => {},
      onSessionInfo: () => {},
      onReplayStart: () => {},
      onSessionDeleted: () => {},
      onSessionSwitchStage: () => {},
      onSessionSwitchCommit: () => {},
      onSessionSwitchRollback: () => {},
    };
    acpClient = new LiveAcpClient(handlers);
    try {
      await acpClient.connect(transport, '/tmp/project');
    } catch (err) {
      console.error('test agent(stdio)启动日志:\n' + agentLog);
      throw err;
    }
  }, 180_000);

  afterAll(async () => {
    acpClient?.disconnect();
    if (childExited === undefined) {
      // disconnect 应已杀进程;兜底等待再强杀,绝不留孤儿。
      await new Promise((r) => setTimeout(r, 1_000));
    }
    rmSync(sandboxDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('initialize + 新建会话 + 完整回合走生产同款 NDJSON framing', { timeout: 90_000 }, async () => {
    await acpClient.newSession('/tmp/project');
    expect(sessionIds.length).toBeGreaterThan(0);
    // 剧本第 1 轮是完整工具回合(write_todos/read_file/edit_file/execute);
    // 权限全部走 ask 会挂起等人批准——切 accept_everything 保持确定性。
    await acpClient.setMode('accept_everything');

    await acpClient.send([{ type: 'text', text: '重构 auth 校验' }]);
    await waitFor(
      () => statuses.at(-1) === 'idle' && updates.some((u) => u.sessionUpdate === 'agent_message_chunk'),
      60_000,
      '回合完成(idle + 至少一条 agent 消息)',
    );
    const chunks = updates
      .filter((u) => u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text')
      .map((u) => (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text' ? u.content.text : ''))
      .join('');
    // 剧本总结句:证明整个工具链(read→edit→execute)在 stdio 传输上真实跑通。
    expect(chunks).toContain('剧本到此播放完毕');
    expect(updates.some((u) => u.sessionUpdate === 'tool_call')).toBe(true);
  });

  it('断开即杀子进程,无孤儿(传输生命周期契约)', { timeout: 15_000 }, async () => {
    acpClient.disconnect();
    await waitFor(() => childExited !== undefined, 10_000, 'transport onClose(子进程退出)');
    expect(childExited).not.toBe(undefined);
  });
});
