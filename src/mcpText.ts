/**
 * MCP 配置的文本面(#142):JSON/YAML 直接编辑。Panda 的内部形状
 * (McpServerConfig 判别联合)与生态文本形状({mcpServers: {name: {...}}})
 * 在这里互转,UI 只拿纯函数。
 *
 * 解析刻意宽容:粘贴来的配置来自任何主流客户端(Claude Desktop /
 * Claude Code / Cursor / Cline / Gemini 的 `mcpServers`,VS Code 的
 * `servers`,只复制了内层的裸 map,Continue 的裸数组…),根形态与字段
 * 别名都认;Panda 不存的字段(env/headers/cwd/…)不静默吞——收进
 * notes 由 UI 明示。语法错误原样抛出(fail-fast,解析器消息自带行号,
 * 不翻译)。序列化只有一种形状:mcpServers 根 + 显式 type + args 数组,
 * 保往返稳定。
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { newMcpServerId, splitArgs, type McpServerConfig } from './mcpServers';

export type McpTextFormat = 'json' | 'yaml';

/** Root wrappers we unwrap when parsing, most-common first. */
const ROOT_KEYS = ['mcpServers', 'servers', 'mcp_servers', 'mcp', 'context_servers', 'extensions'] as const;

/** Entry fields we understand; everything else non-empty counts as dropped. */
const KNOWN_FIELDS = new Set([
  'name', 'type', 'transport', 'command', 'cmd', 'args', 'url', 'httpUrl', 'serverUrl', 'endpoint',
]);

export interface SerializeResult {
  text: string;
  /** Duplicate names got a -2/-3 suffix to keep the round-trip lossless. */
  renames: { from: string; to: string }[];
}

/** Config list → the canonical `{mcpServers: {...}}` document. stdio's args
 * go back to the wire's array shape; an empty args line is omitted. */
export function serializeMcpServers(servers: readonly McpServerConfig[], format: McpTextFormat): SerializeResult {
  const renames: { from: string; to: string }[] = [];
  const seen = new Map<string, number>();
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const server of servers) {
    const used = seen.get(server.name) ?? 0;
    const name = used === 0 ? server.name : `${server.name}-${used + 1}`;
    if (used > 0) renames.push({ from: server.name, to: name });
    seen.set(server.name, used + 1);
    mcpServers[name] =
      server.type === 'stdio'
        ? { type: 'stdio', command: server.command, ...(splitArgs(server.args).length > 0 ? { args: splitArgs(server.args) } : {}) }
        : { type: server.type, url: server.url };
  }
  const doc = { mcpServers };
  return { text: format === 'json' ? `${JSON.stringify(doc, null, 2)}\n` : stringifyYaml(doc), renames };
}

/** What a server still is when its name changed: transport plus address.
 * stdio's args are deliberately outside the identity — editing a server's
 * args in the text view must not cost it the id (and the profile whitelists
 * that reference it, #148). */
function serverIdentity(server: McpServerConfig): string {
  return server.type === 'stdio'
    ? `stdio\0${server.command}`
    : `${server.type}\0${server.url}`;
}

/** Rebinds parsed servers to existing ids (#12): parseMcpConfigText mints a
 * fresh id per entry, so saving the text view used to replace the whole list
 * and silently cut every profile whitelist (#148) — even for a no-op
 * reformat. Survivors are matched same-name first (the text format's primary
 * key — the map slot), then same transport+address (a rename); each existing
 * id binds at most once, document order breaking ties. Unmatched entries
 * keep their fresh ids: they are genuinely new servers. */
export function rebindServerIds(
  servers: readonly McpServerConfig[],
  existing: readonly McpServerConfig[],
): McpServerConfig[] {
  const taken = new Set<string>();
  const byName = new Map(existing.map((server) => [server.name, server]));
  const byIdentity = new Map(existing.map((server) => [serverIdentity(server), server]));
  return servers.map((server) => {
    const prev = [byName.get(server.name), byIdentity.get(serverIdentity(server))]
      .find((candidate) => candidate !== undefined && !taken.has(candidate.id));
    if (prev === undefined) return server;
    taken.add(prev.id);
    return { ...server, id: prev.id };
  });
}

/** Why an entry could not become a server — UI maps these to i18n strings. */
export type McpSkipReason =
  | 'missing-name' // array entry without a name
  | 'invalid-entry' // entry is not an object
  | 'missing-command' // stdio without a command
  | 'missing-url' // remote without a url
  | 'unsupported-type'; // explicit type Panda cannot host (e.g. ws) or unknown

export interface McpParseResult {
  servers: McpServerConfig[];
  skipped: { name: string; reason: McpSkipReason }[];
  /** Non-empty fields Panda does not store (env/headers/…), deduped+sorted. */
  droppedFields: string[];
  /** Values carrying ${...} placeholders were imported literally. */
  hasPlaceholders: boolean;
  renames: { from: string; to: string }[];
  /** Syntax-level failure: the parser's own message (with line info). */
  error: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 'streamable-http' | 'streamable_http' | 'streamableHttp' → 'http' etc.
 * Returns undefined for absent; throws nothing — unknowns stay undefined and
 * surface as unsupported-type when the type was explicit. */
function normalizeType(raw: unknown): { type?: 'stdio' | 'http' | 'sse'; explicit: boolean } {
  if (raw === undefined || raw === null || raw === '') return { explicit: false };
  if (typeof raw !== 'string') return { type: undefined, explicit: true };
  const t = raw.toLowerCase().replace(/[-_]/g, '-');
  if (t === 'stdio' || t === 'local') return { type: 'stdio', explicit: true };
  if (t === 'http' || t === 'streamable-http' || t === 'remote') return { type: 'http', explicit: true };
  if (t === 'sse') return { type: 'sse', explicit: true };
  return { type: undefined, explicit: true };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const PLACEHOLDER = /\$\{[^}]+\}/;

/** One entry (key + raw object) → a server, or a skip reason. Collects the
 * non-empty unknown fields so the UI can say what was dropped. */
function entryToServer(
  name: string,
  raw: unknown,
  dropped: Set<string>,
): { server?: McpServerConfig; reason?: McpSkipReason; placeholders?: boolean } {
  if (!isPlainObject(raw)) return { reason: 'invalid-entry' };
  let placeholders = false;
  const track = (value: string | undefined): string | undefined => {
    if (value && PLACEHOLDER.test(value)) placeholders = true;
    return value;
  };

  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (!KNOWN_FIELDS.has(key) && value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0) && !(isPlainObject(value) && Object.keys(value).length === 0)) {
      dropped.add(key);
    }
  }

  const { type: declaredType, explicit } = normalizeType(raw.type ?? raw.transport);
  const command = track(str(raw.command) ?? str(raw.cmd));
  const urlRaw = track(str(raw.url) ?? str(raw.httpUrl) ?? str(raw.serverUrl) ?? str(raw.endpoint));
  if (explicit && declaredType === undefined) return { reason: 'unsupported-type', placeholders };

  const type =
    declaredType ??
    (command !== undefined
      ? 'stdio'
      : urlRaw !== undefined
        ? (urlRaw.endsWith('/sse') ? 'sse' : 'http')
        : undefined);

  if (type === 'stdio') {
    if (command === undefined) return { reason: 'missing-command', placeholders };
    const rawArgs = raw.args;
    const args = Array.isArray(rawArgs)
      ? rawArgs.filter((a): a is string => typeof a === 'string' && a.length > 0).join(' ')
      : typeof rawArgs === 'string'
        ? rawArgs
        : '';
    if (PLACEHOLDER.test(args)) placeholders = true;
    return { server: { id: newMcpServerId(), name, type: 'stdio', command, args }, placeholders };
  }
  if (type === 'http' || type === 'sse') {
    const url = raw.httpUrl !== undefined || raw.serverUrl !== undefined
      ? (str(raw.httpUrl) ?? str(raw.serverUrl) ?? urlRaw)
      : urlRaw;
    if (url === undefined) return { reason: 'missing-url', placeholders };
    return { server: { id: newMcpServerId(), name, type, url }, placeholders };
  }
  return { reason: 'missing-command', placeholders };
}

/** Text → servers. Tolerant across client dialects; never throws — every
 * failure mode lands in the result (error / skipped / notes). */
export function parseMcpConfigText(text: string): McpParseResult {
  const result: McpParseResult = {
    servers: [], skipped: [], droppedFields: [], hasPlaceholders: false, renames: [], error: null,
  };
  let data: unknown;
  const jsonError = (() => { try { data = JSON.parse(text); return null; } catch (err) { return err; } })();
  if (jsonError !== null) {
    // YAML is a JSON superset; try it before giving up. Note: `no: xxx` and
    // other bare-word fragments parse fine as YAML — a wrong-but-valid
    // document is caught downstream by the shape checks.
    try {
      data = parseYaml(text);
    } catch (yamlError) {
      result.error = `JSON: ${(jsonError instanceof Error ? jsonError.message : String(jsonError))} · YAML: ${(yamlError instanceof Error ? yamlError.message : String(yamlError))}`;
      return result;
    }
  }
  if (data == null) {
    result.error = 'empty document';
    return result;
  }

  const dropped = new Set<string>();

  // Normalize into [name, raw] pairs.
  let entries: [string, unknown][] = [];
  if (isPlainObject(data)) {
    const root: Record<string, unknown> = data;
    const rootKey = ROOT_KEYS.find((key) => isPlainObject(root[key]) || Array.isArray(root[key]));
    const inner = rootKey ? root[rootKey] : looksLikeServerMap(root) ? root : maybeSingleServer(root);
    if (inner === null) {
      result.error = 'unrecognized shape — expected an mcpServers object, a bare map of servers, or an array';
      return result;
    }
    entries = pairsFrom(inner);
  } else if (Array.isArray(data)) {
    entries = pairsFrom(data);
  } else {
    result.error = 'unrecognized shape — the document is neither an object nor an array';
    return result;
  }

  const seen = new Map<string, number>();
  for (const [entryName, raw] of entries) {
    let name = entryName;
    if (isPlainObject(raw)) {
      const inline = str(raw.name);
      if (inline !== undefined && (entryName === '' || entryName === '-')) name = inline;
    }
    if (name === '' || name === '-') {
      result.skipped.push({ name: '(unnamed)', reason: 'missing-name' });
      continue;
    }
    const converted = entryToServer(name, raw, dropped);
    if (converted.placeholders) result.hasPlaceholders = true;
    if (converted.server) {
      const used = seen.get(converted.server.name) ?? 0;
      const unique = used === 0 ? converted.server.name : `${converted.server.name}-${used + 1}`;
      if (used > 0) {
        result.renames.push({ from: converted.server.name, to: unique });
        converted.server = { ...converted.server, name: unique };
      }
      seen.set(unique, (seen.get(unique) ?? 0) + 1);
      result.servers.push(converted.server);
    } else {
      result.skipped.push({ name, reason: converted.reason ?? 'invalid-entry' });
    }
  }
  result.droppedFields = [...dropped].sort();
  return result;
}

/** [name, raw] pairs from a map (key = name) or an array (name field). */
function pairsFrom(inner: unknown): [string, unknown][] {
  if (Array.isArray(inner)) return inner.map((entry) => [isPlainObject(entry) ? str(entry.name) ?? '' : '', entry]);
  if (!isPlainObject(inner)) return [];
  return Object.entries(inner);
}

/** Every value looks like a server object (not e.g. a settings.json root). */
function looksLikeServerMap(data: Record<string, unknown>): boolean {
  const keys = Object.keys(data);
  return keys.length > 0 && keys.every((key) => isPlainObject(data[key]));
}

/** The document itself is one server (has command/url at the top level). */
function maybeSingleServer(data: Record<string, unknown>): Record<string, unknown> | null {
  return data.command !== undefined || data.cmd !== undefined || data.url !== undefined || data.httpUrl !== undefined || data.serverUrl !== undefined ? data : null;
}
