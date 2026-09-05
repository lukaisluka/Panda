import { describe, expect, it, vi } from 'vitest';
import {
  loadProfiles,
  newProfileId,
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
  url: 'ws://localhost:8765/acp',
  workspace: { kind: 'local-directory', path: '/tmp/project' },
  ...overrides,
});

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