import { describe, expect, it, vi } from 'vitest';
import {
  loadProfiles,
  newProfileId,
  saveProfiles,
  updateProfileFields,
  type AgentProfile,
  type ProfileStorage,
} from './profiles';

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
  cwd: '/tmp/project',
  ...overrides,
});

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
    storage.setRaw(JSON.stringify([good, { id: 'no-url', name: '坏条目', cwd: '/x' }, 'string']));
    expect(loadProfiles(storage)).toEqual([good]);
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
    const updated = updateProfileFields(a.id, { url: 'ws://new:1/acp', cwd: '/new/cwd' }, storage);
    expect(updated).toEqual([
      { ...a, url: 'ws://new:1/acp', cwd: '/new/cwd' },
      b,
    ]);
    expect(loadProfiles(storage)).toEqual(updated);
  });

  it('leaves the list unchanged for an unknown id', () => {
    const storage = new MemoryStorage();
    const a = profile();
    saveProfiles([a], storage);
    expect(updateProfileFields('missing', { url: 'ws://x/acp', cwd: '/x' }, storage)).toEqual([a]);
  });
});