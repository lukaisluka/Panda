/// <reference types="node" />

import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LiveAcpClient, type LiveClientHandlers } from './LiveAcpClient';
import { StdioTransport, type StdioChildProcess, type StdioSpawn } from './transport/StdioTransport';
import type { AcpSessionUpdate, SessionStatus } from '../protocol/types';

/**
 * claude-agent-acp 真连 e2e(#154 层 2):对真实 Claude Code 适配器
 * (`@agentclientprotocol/claude-agent-acp`)跑完整客户端管线 —— 握手、
 * 新会话、真实模型回合(花钱)、权限请求真实形状、session/list /
 * session/load / session/delete。层 1(claudeCodeContract.test.ts)把报文
 * 钉进 fixture 进 CI;这一层是手动验收:验证适配器/CLI 升级后的现状是否
 * 仍与 fixture 一致,并捕获录制脚本够不到的交互形状(权限请求)。
 *
 * 默认跳过,显式开启:PANDA_CLAUDE_CODE_E2E=1(要求本机 claude 已登录,
 * 会消耗真实 token,不进 CI)。
 */

const AGENT_PKG = '@agentclientprotocol/claude-agent-acp@0.75.1';

const enabled = process.env.PANDA_CLAUDE_CODE_E2E === '1';

/** The adapter must spawn the real claude CLI; resolve it or fail loudly. */
function resolveClaudeCli(): string {
  return execSync('command -v claude', { shell: '/bin/zsh', encoding: 'utf8' }).trim();
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Same nodeStdioSpawn seam as StdioTransport.e2e.test.ts, here spawning npx via zsh. */
function nodeStdioSpawn(onStderr: (chunk: string) => void, env: NodeJS.ProcessEnv): StdioSpawn {
  return ({ program, args, cwd }) =>
    new Promise<StdioChildProcess>((resolve, reject) => {
      const child: ChildProcess = spawn(program, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      child.once('error', reject);
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
            if (exited || child.exitCode !== null || child.signalCode !== null) {
              resolveKill();
              return;
            }
            child.once('exit', resolveKill);
            child.kill('SIGTERM');
            setTimeout(() => {
              if (!exited) child.kill('SIGKILL');
            }, 3_000).unref();
          }),
      });
    });
}

describe.skipIf(!enabled)('claude-agent-acp 真连 e2e(#154 层 2, 花真实 token)', () => {
  let projectDir = '';
  let agentLog = '';
  let acpClient: LiveAcpClient;
  let transport: StdioTransport;
  let sessionId = '';
  let childExited: number | null | undefined; // undefined = still running
  const updates: AcpSessionUpdate[] = [];
  const statuses: SessionStatus[] = [];
  const deletedSessions: string[] = [];
  const listedSessions: { sessionId: string; cwd: string | null }[][] = [];
  const switchRollbacks: string[] = [];
  const capabilitiesList: { image: boolean; loadSession: boolean; list: boolean; resume: boolean; delete: boolean }[] = [];
  const answeredPermissions = new Set<string>();

  /**
   * claude 的 default 模式是 Manual(每次修改都问)——连纯 Edit 回合也会
   * 挂起等 `session/request_permission`(录制脚本当时是自动应答的,所以
   * fixture 里看不到)。这里模拟 Panda 用户:回合进行期间,每来一个未应答
   * 的权限卡就选 allow_once,直到回合收敛回 idle。必须与 send() 并行跑:
   * prompt 响应要等权限往返之后才返回。
   */
  async function drainPermissions(timeoutMs: number, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (statuses.at(-1) !== 'idle') {
      const pending = updates.find(
        (u) => u.sessionUpdate === 'permission_requested' && !answeredPermissions.has(u.request.toolCallId),
      );
      if (pending && pending.sessionUpdate === 'permission_requested') {
        answeredPermissions.add(pending.request.toolCallId);
        acpClient.resolvePermission(pending.request.toolCallId, 'allow_once');
      }
      if (Date.now() > deadline) {
        throw new Error(`drainPermissions timed out: ${what} (last status: ${statuses.at(-1) ?? 'none'})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  beforeAll(async () => {
    // 纯编辑回合的素材:一个待读取并修改的文件。
    projectDir = mkdtempSync(join(tmpdir(), 'panda-cc-e2e-'));
    writeFileSync(join(projectDir, 'greeting.txt'), 'Hello from Panda e2e');

    const spawnImpl = nodeStdioSpawn(
      (chunk) => (agentLog += chunk),
      {
        ...process.env,
        // 适配器自己 spawn claude CLI;不指名则它在沙箱/非交互环境下会以
        // macOS -88 失败(录制脚本探明的同一坑)。
        CLAUDE_CODE_EXECUTABLE: resolveClaudeCli(),
      },
    );
    transport = new StdioTransport(
      // 裸 spawn('npx') 会挂死在 npm exec/corepack 解析 —— 必须 zsh -lc。
      { program: '/bin/zsh', args: ['-lc', `exec npx -y ${AGENT_PKG}`], cwd: projectDir },
      spawnImpl,
    );
    transport.onClose(() => {
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
      onSessionId: (id) => {
        sessionId = id;
      },
      onDisconnected: () => {},
      onAuthChallenge: () => {},
      onAuthElicitation: () => {},
      onAuthMethods: () => {},
      onAuthenticated: () => {},
      onCapabilities: (caps) => capabilitiesList.push(caps),
      onSessions: (entries) => listedSessions.push(entries.map((e) => ({ sessionId: e.sessionId, cwd: e.cwd }))),
      onSessionInfo: () => {},
      onReplayStart: () => {},
      onSessionDeleted: (id) => deletedSessions.push(id),
      onSessionSwitchStage: () => {},
      onSessionSwitchCommit: () => {},
      onSessionSwitchRollback: (reason) => switchRollbacks.push(reason),
    };
    acpClient = new LiveAcpClient(handlers);
    try {
      await acpClient.connect(transport, projectDir);
    } catch (err) {
      console.error('claude-agent-acp 启动日志:\n' + agentLog);
      throw err;
    }
  }, 240_000);

  afterAll(async () => {
    acpClient?.disconnect();
    if (childExited === undefined) {
      await new Promise((r) => setTimeout(r, 1_000));
    }
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('握手能力矩阵与 session/new(真实 initialize)', { timeout: 120_000 }, () => {
    // 层 1 fixture 断言的同一形状,这次对着活进程:适配器升级若改能力面,这里先红。
    expect(capabilitiesList[0]).toEqual({ image: true, loadSession: true, list: true, resume: true, delete: true });
    expect(sessionId).not.toBe('');
  });

  it('纯编辑回合:权限批准后真实模型跑通 Read→Edit,零 unsupported', { timeout: 300_000 }, async () => {
    const turn = acpClient.send([
      { type: 'text', text: "Read greeting.txt, then append the character ! to the end of the file. Reply with just: done" },
    ]);
    await drainPermissions(280_000, '编辑回合(Edit 权限批准 + 完成)');
    await turn;
    expect(updates.some((u) => u.sessionUpdate === 'agent_message_chunk')).toBe(true);
    const tools = updates.filter((u) => u.sessionUpdate === 'tool_call');
    expect(tools.length).toBeGreaterThan(0);
    expect(updates.some((u) => u.sessionUpdate === 'unsupported')).toBe(false);
  });

  it('bash 权限请求真实形状 + allow_once 应答后回合完成', { timeout: 300_000 }, async () => {
    const before = updates.length;
    const turn = acpClient.send([
      { type: 'text', text: 'Run the shell command `touch side-effect.txt` in the current directory and confirm it succeeded.' },
    ]);
    await drainPermissions(280_000, 'bash 权限批准 + 回合完成');
    await turn;
    // 录制脚本够不到的形状,在这里钉死:toolCallId 关联、选项带 id/kind
    // (真实值:allow-once / allow-with-updates / reject —— kind 落在 Panda
    // 认识的四类里,否则 resolvePermission 找不到选项)。
    const request = updates.find(
      (u, i) => i >= before && u.sessionUpdate === 'permission_requested',
    );
    if (!request || request.sessionUpdate !== 'permission_requested') {
      throw new Error('bash 权限请求未到达');
    }
    expect(request.request.toolCallId.length).toBeGreaterThan(0);
    expect(request.request.options.length).toBeGreaterThan(0);
    for (const option of request.request.options) {
      expect(option.id.length).toBeGreaterThan(0);
      expect(['allow_once', 'allow_always', 'reject_once', 'reject_always']).toContain(option.kind);
    }
  });

  it('session/list 条目形状,session/load 回放历史,session/delete 移除', { timeout: 120_000 }, async () => {
    // session/list 在握手后立即拉取(早于本会话建立),这里的断言是条目
    // 形状;「列表含录制会话」的语义已由层 1 fixture 断言钉死。
    await waitFor(() => listedSessions.length > 0, 30_000, 'session/list 到达');
    const entries = listedSessions[0]!;
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(typeof entry.sessionId).toBe('string');
      expect(entry.sessionId.length).toBeGreaterThan(0);
    }

    const before = updates.length;
    await acpClient.loadSession(sessionId, projectDir);
    await waitFor(() => updates.length > before, 60_000, 'load 回放通知');
    expect(updates.some((u) => u.sessionUpdate === 'user_message')).toBe(true);
    expect(switchRollbacks).toEqual([]);

    await acpClient.deleteSession(sessionId);
    expect(deletedSessions).toEqual([sessionId]);
  });

  it('断开即杀适配器进程,无孤儿', { timeout: 15_000 }, async () => {
    acpClient.disconnect();
    await waitFor(() => childExited !== undefined, 10_000, 'transport onClose(子进程退出)');
    expect(childExited).not.toBe(undefined);
  });
});
