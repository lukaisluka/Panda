import { describe, expect, it, vi } from 'vitest';
import {
  loadMcpServers,
  saveMcpServers,
  subscribeMcpServers,
  toWireMcpServers,
  type McpServerStorage,
} from './mcpServers';

function memoryStorage(initial: Record<string, string> = {}): McpServerStorage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
  };
}

describe('mcpServers storage (issue #71)', () => {
  it('loads empty when nothing is stored', () => {
    expect(loadMcpServers(memoryStorage())).toEqual([]);
  });

  it('round-trips a mixed stdio/http/sse list', () => {
    const storage = memoryStorage();
    saveMcpServers(
      [
        { id: 'a', name: 'fs', type: 'stdio', command: 'npx', args: '-y srv' },
        { id: 'b', name: 'web', type: 'http', url: 'https://x/mcp' },
        { id: 'c', name: 'old', type: 'sse', url: 'https://y/sse' },
      ],
      storage,
    );
    expect(loadMcpServers(storage)).toEqual([
      { id: 'a', name: 'fs', type: 'stdio', command: 'npx', args: '-y srv' },
      { id: 'b', name: 'web', type: 'http', url: 'https://x/mcp' },
      { id: 'c', name: 'old', type: 'sse', url: 'https://y/sse' },
    ]);
  });

  it('drops malformed entries loudly and keeps the valid ones', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const storage = memoryStorage({
        'panda.mcpServers': JSON.stringify([
          { id: 'ok', name: 'fs', type: 'stdio', command: 'npx', args: '' },
          { id: 'no-command', name: 'broken', type: 'stdio', args: '' },
          { id: 'no-url', name: 'broken', type: 'http' },
          { id: 'no-name', type: 'http', url: 'https://x' },
          'not-even-an-object',
        ]),
      });
      expect(loadMcpServers(storage)).toEqual([
        { id: 'ok', name: 'fs', type: 'stdio', command: 'npx', args: '' },
      ]);
      expect(warn).toHaveBeenCalledTimes(4);
    } finally {
      warn.mockRestore();
    }
  });

  it('resets to [] on corrupt JSON or a non-array', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(loadMcpServers(memoryStorage({ 'panda.mcpServers': '{oops' }))).toEqual([]);
      expect(loadMcpServers(memoryStorage({ 'panda.mcpServers': '{"a":1}' }))).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('notifies subscribers on every save (two-writer divergence guard)', () => {
    const lengths: number[] = [];
    const unsubscribe = subscribeMcpServers((servers) => lengths.push(servers.length));
    saveMcpServers([{ id: 'a', name: 'fs', type: 'stdio', command: 'x', args: '' }], memoryStorage());
    saveMcpServers([], memoryStorage());
    unsubscribe();
    expect(lengths).toEqual([1, 0]);
  });
});

describe('toWireMcpServers (issue #71)', () => {
  it('maps stdio with args split and collapsed; env stays empty (no secret storage yet)', () => {
    expect(
      toWireMcpServers([{ id: 'a', name: 'fs', type: 'stdio', command: 'npx', args: '  -y   srv  /tmp ' }]),
    ).toEqual([{ name: 'fs', command: 'npx', args: ['-y', 'srv', '/tmp'], env: [] }]);
  });

  it('maps http and sse with their urls; headers stay empty', () => {
    expect(
      toWireMcpServers([
        { id: 'a', name: 'web', type: 'http', url: 'https://x/mcp' },
        { id: 'b', name: 'old', type: 'sse', url: 'https://y/sse' },
      ]),
    ).toEqual([
      { type: 'http', name: 'web', url: 'https://x/mcp', headers: [] },
      { type: 'sse', name: 'old', url: 'https://y/sse', headers: [] },
    ]);
  });
});
