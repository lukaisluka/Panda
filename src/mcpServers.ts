/**
 * MCP server 配置(issue #71, ADR 0004 决策 3 的 v1 落地):Panda 作为
 * client 在 session/new · session/load 的 `mcpServers` 参数里声明 MCP
 * server,由 agent 侧连接并取得工具 —— 当前协议版本内唯一的客户端执行面。
 *
 * 全局一份(localStorage `panda.mcpServers`),不按 profile 区分:配置的
 * 是"用户想让每个 agent 都能用的工具",临时直连同样受益。stdio server
 * 由 agent 所在主机拉起,http/sse 由 agent 侧拨号;浏览器只持有配置。
 *
 * env/headers(密钥类字段)刻意不入库:localStorage 明文存密钥不妥,
 * 需要时随 secret 存储单独立项。The storage backend is injected like
 * profiles.ts — the browser passes nothing, unit tests pass an in-memory
 * fake.
 */
import type { McpServer } from '@agentclientprotocol/sdk';

/** One configured MCP server. `args` is a single whitespace-separated line —
 * the UI edits it as one string; the wire mapping splits it. */
export type McpServerConfig =
  | { id: string; name: string; type: 'stdio'; command: string; args: string }
  | { id: string; name: string; type: 'http' | 'sse'; url: string };

/** localStorage-shaped backend; injectable for tests. */
export interface McpServerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const MCP_KEY = 'panda.mcpServers';

type McpServersListener = (servers: McpServerConfig[]) => void;

/** Live subscribers — same two-writer rationale as profiles.ts: every write
 * notifies, so a UI copy that never re-reads cannot silently diverge. */
const listeners = new Set<McpServersListener>();

export function subscribeMcpServers(listener: McpServersListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyMcpServers(storage: McpServerStorage): void {
  for (const listener of listeners) listener(loadMcpServers(storage));
}

function defaultStorage(): McpServerStorage {
  // Browser-only by construction: the UI is the only caller without injection.
  return globalThis.localStorage;
}

function isMcpServerConfig(value: unknown): value is McpServerConfig {
  if (typeof value !== 'object' || value === null) return false;
  const { id, name, type, command, args, url } = value as Record<string, unknown>;
  if (typeof id !== 'string' || id.length === 0) return false;
  if (typeof name !== 'string' || name.length === 0) return false;
  if (type === 'stdio') {
    return typeof command === 'string' && command.length > 0 && typeof args === 'string';
  }
  if (type === 'http' || type === 'sse') {
    return typeof url === 'string' && url.length > 0;
  }
  return false;
}

/** Loads the configured list; corrupt JSON resets to [], malformed entries are
 * dropped loudly (best-effort storage, honest console). */
export function loadMcpServers(storage: McpServerStorage = defaultStorage()): McpServerConfig[] {
  let raw: string | null;
  try {
    raw = storage.getItem(MCP_KEY);
  } catch (err) {
    console.warn('[panda/mcp] could not read MCP server config', err);
    return [];
  }
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn('[panda/mcp] MCP server storage is not an array — starting empty');
      return [];
    }
    return parsed.filter((entry) => {
      if (isMcpServerConfig(entry)) return true;
      console.warn(`[panda/mcp] malformed MCP server entry dropped: ${JSON.stringify(entry)}`);
      return false;
    });
  } catch (err) {
    console.warn('[panda/mcp] could not parse MCP server storage — starting empty', err);
    return [];
  }
}

/** Persists the full list; failures warn but never throw. */
export function saveMcpServers(servers: McpServerConfig[], storage: McpServerStorage = defaultStorage()): void {
  try {
    storage.setItem(MCP_KEY, JSON.stringify(servers));
  } catch (err) {
    console.warn('[panda/mcp] could not persist MCP server config', err);
  }
  notifyMcpServers(storage);
}

export function newMcpServerId(): string {
  return globalThis.crypto.randomUUID();
}

/** Splits the one-line args field into the wire's array. Whitespace-only
 * segments collapse away; no quoting semantics — an arg with spaces needs a
 * real array surface if that ever bites. */
function splitArgs(line: string): string[] {
  return line.trim().split(/\s+/).filter((segment) => segment.length > 0);
}

/**
 * Config → ACP wire shape. stdio gets an explicit empty `env` and http/sse an
 * explicit empty `headers` (both required on the wire, deliberately unfilled
 * until secret storage exists — see the module header).
 */
export function toWireMcpServers(servers: readonly McpServerConfig[]): McpServer[] {
  return servers.map((server): McpServer => {
    if (server.type === 'stdio') {
      return { name: server.name, command: server.command, args: splitArgs(server.args), env: [] };
    }
    return { type: server.type, name: server.name, url: server.url, headers: [] };
  });
}
