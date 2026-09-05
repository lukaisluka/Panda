/**
 * CLI 入口。
 *
 * - `serve`(默认建议):WebSocket 桥,每条连接一个 stdio 子进程,供 Panda 直连
 * - `stdio`:裸 stdio 模式,供桥内部使用,也可直接接 Zed 等编辑器调试 agent 本身
 *
 * Node >= 22.5(node:sqlite)。日志只写 stderr:stdio 模式下 stdout 是协议
 * 通道,绝不能混入日志。
 */

import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { mkdirSync } from 'node:fs';
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { createAgentHandler } from './agentServer';
import { buildModelRegistry } from './models';
import { SqliteCheckpointSaver } from './checkpointer';
import { SessionStore } from './sessionStore';
import { makeBackend } from './agentConfig';
import {
  AGENT_ROOT,
  DEFAULT_SANDBOX_DIR,
  DEFAULT_SEED_DIR,
  DEFAULT_STATE_DIR,
  log,
  resetSandbox,
  runServe,
  VERSION,
} from './serve';

/** 极简 .env 加载:只补缺,不覆盖已有环境变量(e2e 的空值覆盖必须赢)。 */
function loadDotEnv(path: string): void {
  if (!existsSync(path)) {
    return;
  }
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1]!;
    let value = match[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function buildParser() {
  return parseArgs({
    allowPositionals: true,
    options: {
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '8766' },
      'sandbox-dir': { type: 'string' },
      'state-dir': { type: 'string' },
      'seed-dir': { type: 'string' },
      'keep-sandbox': { type: 'boolean', default: false },
    },
  });
}

/** stdio 模式:装配 deps 并把 ACP 壳挂到 stdin/stdout 的 ndjson 流上。 */
async function runStdio(sandboxDir: string, stateDir: string): Promise<void> {
  mkdirSync(stateDir, { recursive: true });
  const dbPath = join(stateDir, 'checkpoints.sqlite');
  const models = await buildModelRegistry(process.env);

  const connection = new AgentSideConnection(
    (conn) => {
      const checkpointer = new SqliteCheckpointSaver(dbPath);
      return createAgentHandler(conn, {
        version: VERSION,
        models,
        checkpointer,
        store: new SessionStore(checkpointer.db),
        backend: makeBackend(sandboxDir),
        log: (...args) => log('INFO', args.map(String).join(' ')),
      });
    },
    ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
  );
  // 持有连接引用:构造即开始服务,作用域存活期间不可被回收。
  void connection;
  // 连接随 stdin 关闭而结束;保持进程存活直到 then 的 promise settle。
  await new Promise<void>((resolve) => {
    process.stdin.on('end', resolve);
    process.stdin.on('error', resolve);
    process.stdin.resume();
  });
}

async function main(): Promise<void> {
  const args = buildParser();
  const command = args.positionals[0];
  if (command !== 'serve' && command !== 'stdio') {
    console.error('用法: panda-test-agent <serve|stdio> [选项]');
    process.exitCode = 2;
    return;
  }

  loadDotEnv(join(AGENT_ROOT, '.env'));

  const sandboxDir = resolve(args.values['sandbox-dir'] ?? DEFAULT_SANDBOX_DIR);
  const stateDir = resolve(args.values['state-dir'] ?? DEFAULT_STATE_DIR);

  if (command === 'serve') {
    const port = Number.parseInt(args.values.port ?? '8766', 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      console.error(`非法端口: ${args.values.port}`);
      process.exitCode = 2;
      return;
    }
    await runServe({
      host: args.values.host ?? '127.0.0.1',
      port,
      sandboxDir,
      stateDir,
      seedDir: resolve(args.values['seed-dir'] ?? DEFAULT_SEED_DIR),
      keepSandbox: args.values['keep-sandbox'] === true,
    });
    return;
  }

  // stdio:全新 clone 里也必须可直接运行;已有沙箱则保留,避免编辑器重连时
  // 悄悄抹掉上一条连接产生的文件改动。
  if (!existsSync(sandboxDir)) {
    resetSandbox(DEFAULT_SEED_DIR, sandboxDir);
  }
  await runStdio(sandboxDir, stateDir);
}

main().catch((error) => {
  log('ERROR', String(error?.stack ?? error));
  process.exit(1);
});
