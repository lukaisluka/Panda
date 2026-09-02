import { describe, expect, it } from 'vitest';
import type { SessionEntry } from './store';
import { restoreEndpointSessions, type SessionStorage } from './useLiveSession';

class MemoryStorage implements SessionStorage {
  private readonly entries = new Map<string, string>();

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
}

describe('restoreEndpointSessions', () => {
  it('restores only the selected endpoint cache', () => {
    const storage = new MemoryStorage();
    const previous: SessionEntry[] = [
      { sessionId: 'from-previous-endpoint', cwd: '/previous', title: null, updatedAt: null },
    ];
    const selected: SessionEntry[] = [
      { sessionId: 'from-selected-endpoint', cwd: '/selected', title: 'Selected', updatedAt: null },
    ];
    storage.setItem('panda.sessions:ws://previous/acp', JSON.stringify(previous));
    storage.setItem('panda.sessions:ws://selected/acp', JSON.stringify(selected));

    let visible = previous;
    restoreEndpointSessions('ws://selected/acp', (sessions) => {
      visible = sessions;
    }, storage);

    expect(visible).toEqual(selected);
  });
});
