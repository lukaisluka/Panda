/**
 * WebSocket ↔ stdio 桥:Panda 是 WebSocket 客户端,而 ACP agent 以 stdio
 * 子进程运行(ACP stdio 为行分隔 JSON-RPC;Panda 的 WebSocket 约定是每文
 * 本帧一条 JSON-RPC)。
 *
 * 每条 WebSocket 连接 spawn 一个 `node --import tsx src/main.ts stdio` 子进
 * 程,与 Zed 消费 ACP agent 的方式一致;本模块只做"文本帧 ↔ 行"的哑转发,
 * 不解析协议。子进程 stdout 里混入的非 JSON 行会被过滤并记录日志(有些库
 * 不守规矩往 stdout print,不能让它们破坏协议流);stderr 原样透传到终端,
 * 保持可观测。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';

export const AGENT_ROOT = resolve(dirname(dirname(fileURLToPath(import.meta.url))));
export const DEFAULT_SEED_DIR = join(AGENT_ROOT, 'seed');
export const DEFAULT_SANDBOX_DIR = join(AGENT_ROOT, 'sandbox');
export const DEFAULT_STATE_DIR = join(AGENT_ROOT, '.state');
export const VERSION = JSON.parse(readFileSync(join(AGENT_ROOT, 'package.json'), 'utf8')).version as string;

const TERMINATE_TIMEOUT_MS = 5000;
const CLOSE_HANDSHAKE_GRACE_MS = 1000;

/** 日志只写 stderr(stdout 在 stdio 模式下是协议通道)。 */
export function log(level: 'INFO' | 'WARNING' | 'ERROR', message: string): void {
  const timestamp = new Date().toISOString();
  process.stderr.write(`[${timestamp}] ${level} panda-test-agent: ${message}\n`);
}

/** 把沙箱重置为种子项目的副本,保证剧本的 edit_file 每次都能命中。 */
export function resetSandbox(seedDir: string, sandboxDir: string): void {
  const seed = resolve(seedDir);
  if (!existsSync(seed)) {
    throw new Error(`种子目录不存在: ${seed}`);
  }
  rmSync(sandboxDir, { recursive: true, force: true });
  mkdirSync(dirname(resolve(sandboxDir)), { recursive: true });
  cpSync(seed, sandboxDir, { recursive: true });
  log('INFO', `沙箱已重置: ${sandboxDir} <- ${seed}`);
}

/** SIGTERM 子进程,超时未退则 SIGKILL。 */
async function terminate(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return;
  }
  proc.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolveExit) => proc.once('exit', () => resolveExit())),
    new Promise<false>((resolveTimeout) => {
      const timer = setTimeout(() => resolveTimeout(false), TERMINATE_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]).then((exited) => {
    if (exited === false && proc.exitCode === null && proc.signalCode === null) {
      log('WARNING', `[pid ${proc.pid}] SIGTERM 后 ${TERMINATE_TIMEOUT_MS}ms 未退出,改用 SIGKILL`);
      proc.kill('SIGKILL');
    }
  });
  if (proc.exitCode === null && proc.signalCode === null) {
    await new Promise<void>((resolveExit) => proc.once('exit', () => resolveExit()));
  }
}

function isJsonLine(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** 一条 WebSocket 连接 = 一个 stdio agent 子进程。 */
async function handleConnection(
  socket: WebSocket,
  sandboxDir: string,
  stateDir: string,
  children: Set<ChildProcess>,
): Promise<void> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', join(AGENT_ROOT, 'src', 'main.ts'), 'stdio', '--sandbox-dir', sandboxDir, '--state-dir', stateDir],
    {
      cwd: AGENT_ROOT,
      stdio: ['pipe', 'pipe', 'inherit'],
    },
  );
  const pid = child.pid ?? -1;
  children.add(child);
  child.once('exit', () => children.delete(child));
  log('INFO', `[pid ${pid}] 连接进入,agent 子进程已启动`);

  let finished = false;
  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      log('WARNING', `忽略二进制帧(${Buffer.byteLength(String(data))} 字节)`);
      return;
    }
    const stdin = child.stdin;
    if (!stdin || stdin.destroyed || finished) {
      return;
    }
    stdin.write(`${data.toString('utf8')}\n`);
  });

  // 子进程 stdout 行 → WebSocket 文本帧;过滤掉非 JSON-RPC 的输出
  if (child.stdout) {
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          if (isJsonLine(line)) {
            socket.send(line);
          } else {
            log('WARNING', `[pid ${pid}] 丢弃子进程的非 JSON stdout 行: ${line.slice(0, 200)}`);
          }
        }
        newline = buffer.indexOf('\n');
      }
    });
  }

  const childExited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
  const socketClosed = new Promise<void>((resolve) => {
    socket.once('close', () => resolve());
  });

  const winner = await Promise.race([
    socketClosed.then(() => 'socket' as const),
    childExited.then(() => 'child' as const),
  ]);
  finished = true;

  if (winner === 'child') {
    const code = await childExited;
    const reason = `agent 子进程已退出(退出码 ${code})`;
    log('ERROR', `[pid ${pid}] ${reason}`);
    socket.close(code === 0 ? 1000 : 1011, reason);
    // close 握手若被客户端卡住,宽限期后硬关
    const grace = setTimeout(() => socket.terminate(), CLOSE_HANDSHAKE_GRACE_MS);
    grace.unref?.();
  } else {
    socket.terminate();
  }
  await terminate(child);
  log('INFO', `[pid ${pid}] 连接结束,agent 子进程已退出`);
}

export interface ServeOptions {
  host: string;
  port: number;
  sandboxDir: string;
  stateDir: string;
  seedDir: string;
  keepSandbox: boolean;
}

/** 启动 WebSocket 桥,直到被中断。 */
export async function runServe(options: ServeOptions): Promise<void> {
  if (!options.keepSandbox) {
    resetSandbox(options.seedDir, options.sandboxDir);
  }
  mkdirSync(options.stateDir, { recursive: true });

  const children = new Set<ChildProcess>();
  const wss = new WebSocketServer({ host: options.host, port: options.port, maxPayload: 16 * 1024 * 1024 });
  // ACP 不限定路径,Panda 连 ws://host:port/acp 或任意路径均可
  wss.on('connection', (socket) => {
    void handleConnection(socket, options.sandboxDir, options.stateDir, children).catch((error) => {
      log('ERROR', `连接处理失败: ${String(error?.stack ?? error)}`);
      socket.close(1011, String(error));
    });
  });

  await new Promise<void>((resolve, reject) => {
    wss.once('error', reject);
    wss.once('listening', resolve);
  });
  log('INFO', `Panda 测试 agent 已就绪: ws://${options.host}:${options.port}/acp(沙箱: ${options.sandboxDir})`);

  // Ctrl+C / SIGTERM:关监听、带走所有 agent 子进程,不留孤儿
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log('INFO', `收到 ${signal},关闭 WebSocket 桥`);
    wss.close();
    for (const socket of wss.clients) {
      socket.terminate();
    }
    void Promise.all([...children].map((child) => terminate(child))).finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  await new Promise<void>(() => {});
}
