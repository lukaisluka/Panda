import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { AGENT_ROOT, handleConnection } from '../src/serve';
import type { ChildProcess } from 'node:child_process';

/**
 * serve 桥的进程存活契约(#11):一条连接的 agent 子进程死亡时,仍在途
 * 的帧写入会触发 EPIPE——stdin 若无 error handler,异步 EPIPE 就是
 * unhandled 'error' event,整个 serve 进程(连带其它健康连接)一起炸。
 * 这里钉的是修复后的行为:杀掉子进程后连发帧,进程不崩、连接按
 * child-exit 路径正常收尾。
 */
describe('serve bridge child-death resilience (#11)', () => {
  const cleanups: Array<() => void> = [];
  afterAll(() => {
    for (const fn of cleanups) fn();
  });

  it('frames in flight after the agent child dies are dropped, not fatal', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    cleanups.push(() => wss.close());
    const serverSockets: WebSocket[] = [];
    wss.on('connection', (ws) => serverSockets.push(ws));
    await new Promise<void>((resolve) => wss.once('listening', resolve));
    const address = wss.address() as { port: number };

    const client = new WebSocket(`ws://127.0.0.1:${address.port}/acp`);
    cleanups.push(() => client.terminate());
    await new Promise<void>((resolve) => client.once('open', resolve));
    expect(serverSockets).toHaveLength(1);
    const serverSocket = serverSockets[0]!;

    const sandboxDir = mkdtempSync(join(tmpdir(), 'panda-serve-e2e-sandbox-'));
    const stateDir = mkdtempSync(join(tmpdir(), 'panda-serve-e2e-state-'));
    const children = new Set<ChildProcess>();
    const handled = handleConnection(serverSocket, sandboxDir, stateDir, children);

    // Wait for the spawned agent child, then hard-kill it (crash/OOM/pkill)
    // with a frame backlog still queued client-side: the issue's shape is
    // CONTINUOUS streaming — writes land in the window between the child's
    // death and the exit event settling `finished`, and each one EPIPEs.
    await vi.waitFor(() => expect(children.size).toBe(1));
    const child = [...children][0]!;
    const closed = new Promise<number>((resolve) => client.once('close', (code) => resolve(code)));
    for (let i = 0; i < 500; i++) {
      client.send(JSON.stringify({ jsonrpc: '2.0', id: i, method: 'ping' }));
    }
    child.kill('SIGKILL');
    for (let i = 500; i < 2000; i++) {
      client.send(JSON.stringify({ jsonrpc: '2.0', id: i, method: 'ping' }));
    }

    // Surviving THIS line is the assertion: an unhandled EPIPE would crash
    // the vitest process outright. The connection then settles via the
    // child-exit path (1011) and handleConnection resolves.
    expect(await closed).toBe(1011);
    await expect(handled).resolves.toBeUndefined();
    expect(AGENT_ROOT).toContain('test-agent');
  }, 20_000);
});
