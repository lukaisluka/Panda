import { describe, expect, it, vi } from 'vitest';
import {
  isStdioEndpoint,
  loadProfiles,
  liveTargetEndpoint,
  newProfileId,
  profileEndpoint,
  profileToLiveTarget,
  saveProfiles,
  subscribeProfiles,
  updateProfileFields,
  type AgentProfile,
  type ProfileStorage,
} from './profiles';
import type { Workspace } from './workspace';

/** In-memory localStorage fake — tests run in node, where localStorage is absent. */
class MemoryStorage implements ProfileStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  get raw(): string | null {
    return this.map.get('panda.profiles') ?? null;
  }
  setRaw(value: string | null): void {
    if (value === null) this.map.delete('panda.profiles');
    else this.map.set('panda.profiles', value);
  }
}

const profile = (overrides: Partial<AgentProfile> = {}): AgentProfile => ({
  id: newProfileId(),
  name: 'Mock Agent',
  kind: 'websocket',
  url: 'ws://localhost:8765/acp',
  workspace: { kind: 'local-directory', path: '/tmp/project' },
  mcpServerIds: [],
  ...overrides,
} as AgentProfile);

const stdioProfile = (overrides: Partial<AgentProfile> = {}): AgentProfile => ({
  id: newProfileId(),
  name: 'Local Agent',
  kind: 'stdio',
  command: 'node',
  args: 'agent.js --stdio',
  workspace: { kind: 'local-directory', path: '/tmp/project' },
  mcpServerIds: [],
  ...overrides,
} as AgentProfile);

const workspaces = {
  local: (): Workspace => ({ kind: 'local-directory', path: '/tmp/project' }),
  none: (): Workspace => ({ kind: 'none' }),
};

describe('loadProfiles', () => {
  it('returns [] from empty storage', () => {
    expect(loadProfiles(new MemoryStorage())).toEqual([]);
  });

  it('round-trips a saved list', () => {
    const storage = new MemoryStorage();
    const list = [profile(), profile({ name: 'Gemini 桥', url: 'ws://10.0.0.5:9000/acp' })];
    saveProfiles(list, storage);
    expect(loadProfiles(storage)).toEqual(list);
  });

  it('resets to [] on corrupt JSON', () => {
    const storage = new MemoryStorage();
    storage.setRaw('{not json');
    expect(loadProfiles(storage)).toEqual([]);
  });

  it('resets to [] when the stored value is not an array', () => {
    const storage = new MemoryStorage();
    storage.setRaw('{"id":"x"}');
    expect(loadProfiles(storage)).toEqual([]);
  });

  it('drops malformed entries and keeps valid ones', () => {
    const storage = new MemoryStorage();
    const good = profile();
    const noneKind = profile({ workspace: workspaces.none() });
    storage.setRaw(
      JSON.stringify([
        good,
        noneKind,
        { id: 'no-url', name: '坏条目', workspace: workspaces.local() }, // missing url
        { ...good, id: 'bad-kind', workspace: { kind: 'remote-repository' } }, // unshipped kind
        { ...good, id: 'empty-path', workspace: { kind: 'local-directory', path: '' } }, // pathless local
        'string',
      ]),
    );
    expect(loadProfiles(storage)).toEqual([good, noneKind]);
  });

  it('removes malformed entries from storage on load — the warning fires once (#87)', () => {
    const storage = new MemoryStorage();
    const good = profile();
    storage.setRaw(JSON.stringify([{ id: 'no-url', name: '坏条目', workspace: workspaces.local() }, good, 'string']));
    expect(loadProfiles(storage)).toEqual([good]);
    // 直接清理(拍板):坏条目从 storage 消失,二次加载不再警告、结果稳定
    expect(loadProfiles(storage)).toEqual([good]);
    expect(JSON.parse(String(storage.raw))).toEqual([good]);
  });

  it('purges the key when the stored value is not an array (#87)', () => {
    const storage = new MemoryStorage();
    storage.setRaw('{"id":"x"}');
    expect(loadProfiles(storage)).toEqual([]);
    expect(storage.raw).toBeNull();
  });

  it('survives a storage backend that throws on read', () => {
    const storage = new MemoryStorage();
    vi.spyOn(storage, 'getItem').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(loadProfiles(storage)).toEqual([]);
  });

  it('migrates legacy entries (no kind) to websocket and persists the upgrade (#121)', () => {
    const storage = new MemoryStorage();
    const legacy = { id: 'legacy-1', name: '旧配置', url: 'ws://old:8765/acp', workspace: workspaces.local() };
    storage.setRaw(JSON.stringify([legacy]));
    const loaded = loadProfiles(storage);
    expect(loaded).toEqual([{ ...legacy, kind: 'websocket', mcpServerIds: [] }]);
    // The upgrade is written back once — a second load is a plain round-trip.
    expect(JSON.parse(String(storage.raw))).toEqual([{ ...legacy, kind: 'websocket', mcpServerIds: [] }]);
    expect(loadProfiles(storage)).toEqual(loaded);
  });

  it('round-trips stdio profiles (args may be empty)', () => {
    const storage = new MemoryStorage();
    const local = stdioProfile({ args: '' });
    saveProfiles([local], storage);
    expect(loadProfiles(storage)).toEqual([local]);
  });

  it('drops a stdio entry without a command, keeps neighbors', () => {
    const storage = new MemoryStorage();
    const good = profile();
    const bad = { id: 'no-cmd', name: '空命令', kind: 'stdio', args: 'x', workspace: workspaces.local() };
    storage.setRaw(JSON.stringify([bad, good]));
    expect(loadProfiles(storage)).toEqual([good]);
    expect(JSON.parse(String(storage.raw))).toEqual([good]);
  });

  it('defaults a missing stdio args field to the empty string', () => {
    const storage = new MemoryStorage();
    storage.setRaw(
      JSON.stringify([{ id: 'a', name: 'A', kind: 'stdio', command: 'node', workspace: workspaces.none() }]),
    );
    expect(loadProfiles(storage)).toEqual([
      { id: 'a', name: 'A', kind: 'stdio', command: 'node', args: '', workspace: workspaces.none(), mcpServerIds: [] },
    ]);
  });
});

describe('saveProfiles', () => {
  it('survives a storage backend that throws on write', () => {
    const storage = new MemoryStorage();
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => saveProfiles([profile()], storage)).not.toThrow();
    expect(storage.raw).toBeNull();
  });
});

describe('updateProfileFields', () => {
  it('updates only the target profile and persists', () => {
    const storage = new MemoryStorage();
    const a = profile();
    const b = profile({ name: 'B' });
    saveProfiles([a, b], storage);
    const updated = updateProfileFields(a.id, { url: 'ws://new:1/acp', workspace: workspaces.none() }, storage);
    expect(updated).toEqual([
      { ...a, url: 'ws://new:1/acp', workspace: workspaces.none() },
      b,
    ]);
    expect(loadProfiles(storage)).toEqual(updated);
  });

  it('leaves the list unchanged for an unknown id', () => {
    const storage = new MemoryStorage();
    const a = profile();
    saveProfiles([a], storage);
    expect(updateProfileFields('missing', { url: 'ws://x/acp', workspace: workspaces.none() }, storage)).toEqual([a]);
  });

  it('renames a profile and ignores blank name/url (they can never be blanked)', () => {
    const storage = new MemoryStorage();
    const a = profile();
    saveProfiles([a], storage);
    expect(updateProfileFields(a.id, { name: '  重命名  ' }, storage)).toEqual([{ ...a, name: '  重命名  ' }]);
    expect(updateProfileFields(a.id, { name: '   ', url: '' }, storage)).toEqual([{ ...a, name: '  重命名  ' }]);
  });

  it('applies command/args to stdio profiles and blanks args on demand (#121)', () => {
    const storage = new MemoryStorage();
    const a = stdioProfile();
    saveProfiles([a], storage);
    expect(updateProfileFields(a.id, { command: 'bun', args: '' }, storage)).toEqual([
      { ...a, command: 'bun', args: '' },
    ]);
  });

  it('ignores cross-kind endpoint fields loudly (#121)', () => {
    const storage = new MemoryStorage();
    const ws = profile();
    const local = stdioProfile();
    saveProfiles([ws, local], storage);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(updateProfileFields(ws.id, { command: 'node', args: 'x' }, storage)).toEqual([ws, local]);
    expect(updateProfileFields(local.id, { url: 'ws://x/acp' }, storage)).toEqual([ws, local]);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('endpoint derivation (#121)', () => {
  it('derives the endpoint from either profile kind', () => {
    expect(profileEndpoint(profile({ url: 'ws://h:1/acp' }))).toBe('ws://h:1/acp');
    expect(profileEndpoint(stdioProfile({ command: 'node', args: 'x y' }))).toBe('stdio: node x y');
    expect(profileEndpoint(stdioProfile({ args: '   ' }))).toBe('stdio: node');
  });

  it('trims through the live target before deriving', () => {
    expect(liveTargetEndpoint(profileToLiveTarget(profile({ url: '  ws://h/acp  ' })))).toBe('ws://h/acp');
    expect(liveTargetEndpoint(profileToLiveTarget(stdioProfile({ command: ' node ', args: ' a ' })))).toBe('stdio: node a');
    // inner whitespace runs collapse: the endpoint (and its session key) must
    // not depend on how the user spaced the args
    expect(liveTargetEndpoint(profileToLiveTarget(stdioProfile({ args: '  x   y  ' })))).toBe('stdio: node x y');
  });

  it('recognizes stdio endpoint strings', () => {
    expect(isStdioEndpoint('stdio: node x')).toBe(true);
    expect(isStdioEndpoint('ws://h/acp')).toBe(false);
    expect(isStdioEndpoint(null)).toBe(false);
  });
});

describe('subscribeProfiles', () => {
  // Storage has two writers (sidebar CRUD + connect-time write-back); the
  // subscription is what keeps UI copies from diverging (single source).
  it('notifies with the stored list on every write and unsubscribes cleanly', () => {
    const storage = new MemoryStorage();
    const seen: AgentProfile[][] = [];
    const unsubscribe = subscribeProfiles((profiles) => seen.push(profiles));

    const a = profile();
    saveProfiles([a], storage);
    updateProfileFields(a.id, { url: 'ws://new:1/acp', workspace: workspaces.none() }, storage);

    unsubscribe();
    saveProfiles([profile()], storage);

    expect(seen).toEqual([[a], [{ ...a, url: 'ws://new:1/acp', workspace: workspaces.none() }]]);
  });
});
describe('mcpServerIds whitelist (#148)', () => {
  it('reads pre-#148 entries (no field) as an empty whitelist', () => {
    const storage = new MemoryStorage();
    storage.setRaw(JSON.stringify([
      { id: 'p1', name: 'Old', kind: 'websocket', url: 'ws://x/acp', workspace: workspaces.local() },
    ]));
    expect(loadProfiles(storage)[0]?.mcpServerIds).toEqual([]);
  });

  it('round-trips whitelisted ids', () => {
    const storage = new MemoryStorage();
    saveProfiles([profile({ mcpServerIds: ['s1', 's2'] })], storage);
    expect(loadProfiles(storage)[0]?.mcpServerIds).toEqual(['s1', 's2']);
  });

  it('drops non-string and empty entries from a hand-edited whitelist', () => {
    const storage = new MemoryStorage();
    storage.setRaw(JSON.stringify([
      { id: 'p1', name: 'Old', kind: 'websocket', url: 'ws://x/acp', workspace: workspaces.local(),
        mcpServerIds: ['s1', 42, '', null, 's2'] },
    ]));
    expect(loadProfiles(storage)[0]?.mcpServerIds).toEqual(['s1', 's2']);
  });

  it('reads a non-array whitelist as empty, not as an error', () => {
    const storage = new MemoryStorage();
    storage.setRaw(JSON.stringify([
      { id: 'p1', name: 'Old', kind: 'websocket', url: 'ws://x/acp', workspace: workspaces.local(),
        mcpServerIds: 's1' },
    ]));
    expect(loadProfiles(storage)[0]?.mcpServerIds).toEqual([]);
  });
});
