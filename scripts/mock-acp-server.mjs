#!/usr/bin/env node
/**
 * Dev-only mock ACP service for Panda (Phase 1/2 smoke testing).
 *
 * Panda is a pure protocol client — the real ACP service is owned and started
 * outside this repo. This script stands in for that service during
 * development: a scripted SDK `agent()` app exposed over WebSocket, so the
 * browser client can be exercised end-to-end without a real agent.
 *
 *   node scripts/mock-acp-server.mjs          # ws://localhost:8765/acp
 *   PORT=9000 node scripts/mock-acp-server.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION, agent, methods } from '@agentclientprotocol/sdk';
import { AcpServer } from '@agentclientprotocol/sdk/experimental/server';
import { createNodeWebSocketUpgradeHandler } from '@agentclientprotocol/sdk/experimental/node';

const PORT = Number(process.env.PORT ?? 8765);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const OLD_CODE = `export function verifySessionA(token: string) {
  if (!token.startsWith('Bearer ')) return false;
  return token.length > 32;
}

export function verifySessionB(token: string) {
  if (!token.startsWith('Bearer ')) return false;
  return token.length > 32;
}`;

const NEW_CODE = `export function verifySession(token: string) {
  if (!token.startsWith('Bearer ')) return false;
  return token.length > 32;
}`;

/** Base64 SVG standing in for an agent-produced screenshot. */
const TEST_IMAGE = {
  type: 'image',
  data: 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMjAiIGhlaWdodD0iOTYiPjxyZWN0IHdpZHRoPSIzMjAiIGhlaWdodD0iOTYiIHJ4PSI4IiBmaWxsPSIjMTIyMTFhIi8+PHRleHQgeD0iMTQiIHk9IjI2IiBmaWxsPSIjN2VlMmE4IiBmb250LWZhbWlseT0idWktbW9ub3NwYWNlLG1vbm9zcGFjZSIgZm9udC1zaXplPSIxMyI+cG5wbSB0ZXN0IHNyYy9fX3Rlc3RzX18vYXV0aC5zcGVjLnRzPC90ZXh0Pjx0ZXh0IHg9IjE0IiB5PSI0OCIgZmlsbD0iIzlhYTg5YiIgZm9udC1mYW1pbHk9InVpLW1vbm9zcGFjZSxtb25vc3BhY2UiIGZvbnQtc2l6ZT0iMTIiPuKckyBoYW5kbGVMb2dpbiAoMTJtcyk8L3RleHQ+PHRleHQgeD0iMTQiIHk9IjY4IiBmaWxsPSIjOWFhODliIiBmb250LWZhbWlseT0idWktbW9ub3NwYWNlLG1vbm9zcGFjZSIgZm9udC1zaXplPSIxMiI+4pyTIHJlZnJlc2hUb2tlbiAoOW1zKTwvdGV4dD48dGV4dCB4PSIxNCIgeT0iODgiIGZpbGw9IiM5YWE4OWIiIGZvbnQtZmFtaWx5PSJ1aS1tb25vc3BhY2UsbW9ub3NwYWNlIiBmb250LXNpemU9IjEyIj7inJMgdmVyaWZ5U2Vzc2lvbiAoMjFtcyk8L3RleHQ+PC9zdmc+',
  mimeType: 'image/svg+xml',
};

/**
 * Durable sessions — the server's whole point for Phase 2 E2E: they survive
 * client disconnects AND this process restarting, like a real agent that
 * persists sessions to disk. History entries are the exact session/update
 * payloads to replay.
 */
const SESSIONS_FILE = join(dirname(fileURLToPath(import.meta.url)), '.mock-sessions.json');
const sessions = new Map(); // sessionId -> { cwd, title, updatedAt, turns, history }

try {
  const persisted = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'));
  for (const [sessionId, entry] of Object.entries(persisted)) {
    // The persisted map keys ARE the ids; restore the field onto the entry.
    sessions.set(sessionId, { ...entry, sessionId });
  }
  console.log(`[mock] restored ${sessions.size} persisted session(s) from disk`);
} catch {
  console.log('[mock] no persisted sessions — starting clean');
}

const saveSoon = (() => {
  let timer = null;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions)));
      } catch (err) {
        console.warn('[mock] could not persist sessions:', err.message);
      }
    }, 100);
  };
})();

const touch = (entry) => {
  entry.updatedAt = new Date().toISOString();
  saveSoon();
};

/** One scripted agent per connection; session state lives in the shared map. */
function createMockAgent() {
  const cancelledSessions = new Set();

  return agent({ name: 'mock-agent' })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'mock-agent', title: 'Mock Agent', version: '0.0.0' },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true },
        sessionCapabilities: { list: {}, resume: {}, delete: {} },
      },
    }))
    .onRequest(methods.agent.session.new, (ctx) => {
      // Random suffix like a real agent's UUIDs — a restart must never
      // recycle ids that clients still remember locally.
      const sessionId = `mock-session-${globalThis.crypto.randomUUID().slice(0, 8)}`;
      sessions.set(sessionId, {
        cwd: ctx.params.cwd,
        title: null,
        updatedAt: new Date().toISOString(),
        turns: 0,
        history: [],
      });
      saveSoon();
      console.log(`[mock] session/new ${sessionId} (cwd=${ctx.params.cwd})`);
      return { sessionId };
    })
    .onRequest(methods.agent.session.list, () => ({
      sessions: [...sessions.values()].map(({ sessionId, cwd, title, updatedAt }) => ({
        sessionId,
        cwd,
        title,
        updatedAt,
      })),
    }))
    .onRequest(methods.agent.session.load, async (ctx) => {
      const entry = sessions.get(ctx.params.sessionId);
      if (!entry) throw new Error(`unknown session: ${ctx.params.sessionId}`);
      console.log(`[mock] session/load ${ctx.params.sessionId} — replaying ${entry.history.length} updates`);
      for (const update of entry.history) {
        await ctx.client.notify(methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update,
        });
      }
      return {};
    })
    .onRequest(methods.agent.session.resume, (ctx) => {
      if (!sessions.has(ctx.params.sessionId)) {
        throw new Error(`unknown session: ${ctx.params.sessionId}`);
      }
      console.log(`[mock] session/resume ${ctx.params.sessionId} (no replay)`);
      return {};
    })
    .onRequest(methods.agent.session.delete, (ctx) => {
      if (!sessions.delete(ctx.params.sessionId)) {
        throw new Error(`unknown session: ${ctx.params.sessionId}`);
      }
      saveSoon();
      console.log(`[mock] session/delete ${ctx.params.sessionId}`);
      return {};
    })
    .onNotification(methods.agent.session.cancel, (ctx) => {
      cancelledSessions.add(ctx.params.sessionId);
      console.log(`[mock] cancel requested for ${ctx.params.sessionId}`);
    })
    .onRequest(methods.agent.session.prompt, async (ctx) => {
      const { sessionId } = ctx.params;
      const entry = sessions.get(sessionId);
      if (!entry) throw new Error(`unknown session: ${sessionId}`);
      const cancelled = () => cancelledSessions.has(sessionId);
      const record = (updateObj) => {
        entry.history.push(updateObj);
        saveSoon();
      };
      const update = (updateObj) => {
        record(updateObj);
        return ctx.client.notify(methods.client.session.update, { sessionId, update: updateObj });
      };
      const text = ctx.params.prompt.find((block) => block.type === 'text')?.text ?? '';
      const images = ctx.params.prompt.filter((block) => block.type === 'image');

      const finish = (stopReason) => {
        cancelledSessions.delete(sessionId);
        touch(entry);
        if (!entry.title && stopReason === 'end_turn') {
          // Agents title sessions once there is something to name them after.
          entry.title = `重构 ${text.slice(0, 10)}`;
          const info = { sessionUpdate: 'session_info_update', title: entry.title, updatedAt: entry.updatedAt };
          record(info);
          void ctx.client
            .notify(methods.client.session.update, { sessionId, update: info })
            .catch(() => {});
        }
        return { stopReason };
      };

      entry.turns += 1;
      touch(entry);
      console.log(
        `[mock] prompt on ${sessionId} (turn ${entry.turns}, images=${images.length}): ${text.slice(0, 50)}`,
      );
      // Replay must include the user's turn (v1: user_message_chunk).
      for (const content of ctx.params.prompt) {
        record({ sessionUpdate: 'user_message_chunk', content });
      }

      if (entry.turns > 1) {
        for (const chunk of ['收到：「', text.slice(0, 40), '」。', '这是 mock agent 的简短回应。']) {
          if (cancelled()) return finish('cancelled');
          await update({
            sessionUpdate: 'agent_message_chunk',
            messageId: `reply-${entry.turns}`,
            content: { type: 'text', text: chunk },
          });
          await sleep(150);
        }
        return finish('end_turn');
      }

      // First turn mirrors the Phase 0 fixture story so visuals stay comparable.
      await update({
        sessionUpdate: 'agent_thought_chunk',
        messageId: 'thought-1',
        content: {
          type: 'text',
          text: '用户要重构 auth 校验。先读现有实现，确认两处重复，再抽取公共函数，最后跑测试。',
        },
      });
      await sleep(500);
      if (cancelled()) return finish('cancelled');

      await update({
        sessionUpdate: 'plan',
        entries: [
          { content: '读取 src/auth/session.ts，确认两处重复实现的现状', priority: 'high', status: 'in_progress' },
          { content: '抽取 verifySession()，让两处调用点委托', priority: 'high', status: 'pending' },
          { content: '跑一遍 auth 测试，确认行为不变', priority: 'medium', status: 'pending' },
        ],
      });
      await sleep(400);
      if (cancelled()) return finish('cancelled');

      await update({
        sessionUpdate: 'tool_call',
        toolCallId: 'read-1',
        title: 'Read file: src/auth/session.ts',
        kind: 'read',
        status: 'pending',
        locations: [{ path: '/tmp/project/src/auth/session.ts', line: 12 }],
      });
      await sleep(250);
      await update({ sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'in_progress' });
      await sleep(450);
      if (cancelled()) return finish('cancelled');
      await update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'read-1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: '两处 verifyToken 重复实现，行为完全一致。' } }],
      });
      await sleep(300);

      for (const chunk of [
        '读完 `src/auth/session.ts`：',
        '`verifySessionA` 和 `verifySessionB` 是完全相同的实现。',
        '我建议抽取一个 `verifySession()`，两个调用点都委托给它。',
      ]) {
        if (cancelled()) return finish('cancelled');
        await update({
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg-1',
          content: { type: 'text', text: chunk },
        });
        await sleep(220);
      }
      await update({ sessionUpdate: 'agent_message_chunk', messageId: 'msg-1', content: TEST_IMAGE });
      await sleep(300);
      if (cancelled()) return finish('cancelled');

      await update({
        sessionUpdate: 'tool_call',
        toolCallId: 'edit-1',
        title: 'Edit file: src/auth/session.ts',
        kind: 'edit',
        status: 'pending',
        locations: [{ path: '/tmp/project/src/auth/session.ts', line: 42 }],
      });
      await sleep(350);

      const answer = await ctx.client.request(methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId: 'edit-1', title: 'Edit file: src/auth/session.ts', kind: 'edit', status: 'pending' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'allow-always', name: 'Always allow for this file', kind: 'allow_always' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      });
      console.log(`[mock] permission outcome: ${JSON.stringify(answer.outcome)}`);

      if (answer.outcome.outcome === 'cancelled') {
        await update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit-1', status: 'cancelled' });
        return finish('cancelled');
      }
      if (answer.outcome.optionId.startsWith('reject')) {
        await update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit-1', status: 'cancelled' });
        for (const chunk of ['好的，已取消这次修改，文件保持原样。', '需要我换个思路（比如只加注释标记重复）吗？']) {
          await update({
            sessionUpdate: 'agent_message_chunk',
            messageId: 'msg-2',
            content: { type: 'text', text: chunk },
          });
          await sleep(250);
        }
        return finish('end_turn');
      }

      await update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit-1', status: 'in_progress' });
      await sleep(600);
      if (cancelled()) return finish('cancelled');
      await update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'edit-1',
        status: 'completed',
        content: [
          { type: 'diff', path: '/tmp/project/src/auth/session.ts', oldText: OLD_CODE, newText: NEW_CODE },
        ],
      });
      await update({
        sessionUpdate: 'plan',
        entries: [
          { content: '读取 src/auth/session.ts，确认两处重复实现的现状', priority: 'high', status: 'completed' },
          { content: '抽取 verifySession()，让两处调用点委托', priority: 'high', status: 'completed' },
          { content: '跑一遍 auth 测试，确认行为不变', priority: 'medium', status: 'in_progress' },
        ],
      });
      await update({
        sessionUpdate: 'usage_update',
        used: 48213,
        size: 200000,
        cost: { amount: 0.34, currency: 'USD' },
      });
      for (const chunk of ['已抽取 `verifySession()`，两处调用点都已委托。', '测试我这边模拟全部通过（mock）。']) {
        await update({
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg-3',
          content: { type: 'text', text: chunk },
        });
        await sleep(250);
      }
      return finish('end_turn');
    });
}

const acpServer = new AcpServer({ createAgent: createMockAgent });
const httpServer = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Panda mock ACP service — connect over WebSocket at /acp\n');
});
const wss = new WebSocketServer({ noServer: true });
httpServer.on('upgrade', (req, socket, head) => {
  console.log(`[mock] websocket upgrade: ${req.url}`);
  createNodeWebSocketUpgradeHandler(acpServer, wss)(req, socket, head);
});
httpServer.listen(PORT, () => {
  console.log(`[mock] ACP service listening on ws://localhost:${PORT}/acp (durable sessions enabled)`);
});
