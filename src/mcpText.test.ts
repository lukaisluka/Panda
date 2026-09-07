import { describe, expect, it } from 'vitest';
import type { McpServerConfig } from './mcpServers';
import {
  parseMcpConfigText,
  serializeMcpServers,
} from './mcpText';

/** stripId — the parser mints fresh ids; comparisons ignore them. */
function stripId(servers: McpServerConfig[]) {
  return servers.map(({ id: _id, ...rest }) => rest);
}

const stdio: McpServerConfig = {
  id: 'a', name: 'filesystem', type: 'stdio',
  command: 'npx', args: '-y @modelcontextprotocol/server-filesystem /Users/me',
};
const http: McpServerConfig = { id: 'b', name: 'context7', type: 'http', url: 'https://mcp.context7.com/mcp' };

describe('serializeMcpServers', () => {
  it('JSON: stdio args rejoin the wire array, empty args omitted', () => {
    const { text, renames } = serializeMcpServers([
      stdio,
      { id: 'c', name: 'echo', type: 'stdio', command: 'echo', args: '  ' },
    ], 'json');
    expect(renames).toEqual([]);
    const parsed = JSON.parse(text);
    expect(parsed.mcpServers.filesystem).toEqual({
      type: 'stdio', command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/me'],
    });
    expect(parsed.mcpServers.echo).toEqual({ type: 'stdio', command: 'echo' });
  });

  it('http/sse carry type + url', () => {
    const sse: McpServerConfig = { id: 'd', name: 'legacy', type: 'sse', url: 'https://x/sse' };
    const { text } = serializeMcpServers([http, sse], 'json');
    const parsed = JSON.parse(text);
    expect(parsed.mcpServers.context7).toEqual({ type: 'http', url: 'https://mcp.context7.com/mcp' });
    expect(parsed.mcpServers.legacy).toEqual({ type: 'sse', url: 'https://x/sse' });
  });

  it('empty list serializes to an empty mcpServers map', () => {
    expect(serializeMcpServers([], 'json').text).toBe('{\n  "mcpServers": {}\n}\n');
  });

  it('duplicate names get -2/-3 suffixes and are reported', () => {
    const twinA: McpServerConfig = { id: 'e', name: 'twin', type: 'stdio', command: 'a', args: '' };
    const twinB: McpServerConfig = { id: 'f', name: 'twin', type: 'stdio', command: 'b', args: '' };
    const twinC: McpServerConfig = { id: 'g', name: 'twin', type: 'stdio', command: 'c', args: '' };
    const { text, renames } = serializeMcpServers([twinA, twinB, twinC], 'json');
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed.mcpServers)).toEqual(['twin', 'twin-2', 'twin-3']);
    expect(renames).toEqual([
      { from: 'twin', to: 'twin-2' },
      { from: 'twin', to: 'twin-3' },
    ]);
  });

  it('YAML format is valid YAML with the same shape', () => {
    const { text } = serializeMcpServers([stdio], 'yaml');
    expect(text).toContain('mcpServers:');
    expect(text).toContain('command: npx');
    // round-trips through the YAML parser back to the same document
    const { servers } = parseMcpConfigText(text);
    expect(stripId(servers)).toEqual([stripId([stdio])[0]]);
  });
});

describe('parseMcpConfigText — dialect tolerance', () => {
  it('Claude Desktop: mcpServers root, stdio without type, env collected as dropped', () => {
    const { servers, skipped, droppedFields, error } = parseMcpConfigText(JSON.stringify({
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/me'],
          env: { GITHUB_TOKEN: 'x' },
        },
      },
    }));
    expect(error).toBeNull();
    expect(skipped).toEqual([]);
    expect(stripId(servers)).toEqual([{ name: 'filesystem', type: 'stdio', command: 'npx', args: '-y @modelcontextprotocol/server-filesystem /Users/me' }]);
    expect(droppedFields).toEqual(['env']);
  });

  it('Cursor: url without type infers http; /sse suffix infers sse', () => {
    const { servers } = parseMcpConfigText(JSON.stringify({
      mcpServers: {
        remote: { url: 'http://localhost:3000/mcp', headers: { K: 'v' } },
        legacy: { url: 'https://old.example/sse' },
      },
    }));
    expect(stripId(servers)).toEqual([
      { name: 'remote', type: 'http', url: 'http://localhost:3000/mcp' },
      { name: 'legacy', type: 'sse', url: 'https://old.example/sse' },
    ]);
  });

  it('Claude Code: explicit streamable-http alias normalizes to http', () => {
    const { servers } = parseMcpConfigText(JSON.stringify({
      mcpServers: { api: { type: 'streamable-http', url: 'https://api.example.com/mcp' } },
    }));
    expect(stripId(servers)).toEqual([{ name: 'api', type: 'http', url: 'https://api.example.com/mcp' }]);
  });

  it('VS Code: servers root key', () => {
    const { servers } = parseMcpConfigText(JSON.stringify({
      servers: { memory: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] } },
    }));
    expect(stripId(servers)).toEqual([{ name: 'memory', type: 'stdio', command: 'npx', args: '-y @modelcontextprotocol/server-memory' }]);
  });

  it('Gemini: httpUrl field maps to a http url', () => {
    const { servers } = parseMcpConfigText(JSON.stringify({
      mcpServers: { stream: { httpUrl: 'https://g.example/mcp' } },
    }));
    expect(stripId(servers)).toEqual([{ name: 'stream', type: 'http', url: 'https://g.example/mcp' }]);
  });

  it('bare map (inner object pasted alone) and bare array (Continue) both parse', () => {
    const bareMap = parseMcpConfigText(JSON.stringify({ fs: { command: 'fs-server' } }));
    expect(stripId(bareMap.servers)).toEqual([{ name: 'fs', type: 'stdio', command: 'fs-server', args: '' }]);

    const bareArray = parseMcpConfigText(JSON.stringify([
      { name: 'one', command: 'a' },
      { name: 'two', url: 'https://two/mcp' },
    ]));
    expect(stripId(bareArray.servers).map((s) => s.name)).toEqual(['one', 'two']);
    expect(bareArray.servers[1]?.type).toBe('http');
  });

  it('YAML input parses (YAML is JSON superset path)', () => {
    const { servers, error } = parseMcpConfigText([
      'mcpServers:',
      '  goose:',
      '    cmd: uvx',
      "    args: ['--refresh', 'tooluniverse']",
    ].join('\n'));
    expect(error).toBeNull();
    // Goose's cmd alias + YAML flow-sequence args
    expect(stripId(servers)).toEqual([{ name: 'goose', type: 'stdio', command: 'uvx', args: '--refresh tooluniverse' }]);
  });

  it('args as a string survives verbatim', () => {
    const { servers } = parseMcpConfigText(JSON.stringify({
      mcpServers: { s: { command: 'run', args: '--flag "quoted value"' } },
    }));
    const s = servers[0];
    if (!s || s.type !== 'stdio') throw new Error('expected stdio entry');
    expect(s.args).toBe('--flag "quoted value"');
  });

  it('${...} placeholders import literally and are flagged', () => {
    const { servers, hasPlaceholders } = parseMcpConfigText(JSON.stringify({
      mcpServers: { gh: { command: 'gh-mcp', env: { T: '${GH_TOKEN}' } }, u: { url: '${BASE}/mcp' } },
    }));
    expect(hasPlaceholders).toBe(true);
    expect(servers).toContainEqual({ id: expect.any(String), name: 'u', type: 'http', url: '${BASE}/mcp' });
  });

  it('duplicate array names get suffixed and reported', () => {
    const { servers, renames } = parseMcpConfigText(JSON.stringify([
      { name: 'same', command: 'a' },
      { name: 'same', command: 'b' },
    ]));
    expect(servers.map((s) => s.name)).toEqual(['same', 'same-2']);
    expect(renames).toEqual([{ from: 'same', to: 'same-2' }]);
  });
});

describe('parseMcpConfigText — failures', () => {
  it('broken JSON/YAML reports both parser messages', () => {
    const { error, servers } = parseMcpConfigText('{ "mcpServers": {');
    expect(error).toContain('JSON:');
    expect(error).toContain('YAML:');
    expect(servers).toEqual([]);
  });

  it('stdio without a command / remote without a url / unknown type are skipped with reasons', () => {
    const { servers, skipped } = parseMcpConfigText(JSON.stringify({
      mcpServers: {
        noCmd: { type: 'stdio', args: ['x'] },
        noUrl: { type: 'http' },
        wsOnly: { type: 'ws', url: 'wss://x' },
      },
    }));
    expect(servers).toEqual([]);
    expect(skipped).toEqual([
      { name: 'noCmd', reason: 'missing-command' },
      { name: 'noUrl', reason: 'missing-url' },
      { name: 'wsOnly', reason: 'unsupported-type' },
    ]);
  });

  it('array entry without a name is skipped', () => {
    const { skipped } = parseMcpConfigText('[{ "command": "x" }]');
    expect(skipped).toEqual([{ name: '(unnamed)', reason: 'missing-name' }]);
  });

  it('an unrelated JSON document is an unrecognized shape, not a false success', () => {
    const { error } = parseMcpConfigText('{"name": "panda", "version": 2}');
    expect(error).toContain('unrecognized shape');
  });
});

describe('serialize → parse round-trip', () => {
  it('json and yaml both survive a round-trip losslessly (ids aside)', () => {
    const list: McpServerConfig[] = [stdio, http, { id: 'h', name: 'legacy', type: 'sse', url: 'https://x/sse' }];
    for (const format of ['json', 'yaml'] as const) {
      const { text } = serializeMcpServers(list, format);
      const { servers, error } = parseMcpConfigText(text);
      expect(error).toBeNull();
      expect(stripId(servers)).toEqual(stripId(list));
    }
  });
});
