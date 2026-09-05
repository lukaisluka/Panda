/**
 * Agent 配置（issue #2, ADR 0001; issue #23, ADR 0005): saved connection
 * presets — name + endpoint + default workspace, persisted to localStorage
 * per browser. One active connection at a time; switching profiles switches
 * the connection target. Sessions stay keyed by endpoint
 * (panda.sessions:<url>) and are NOT touched by profile CRUD — deleting a
 * profile never deletes remembered sessions.
 *
 * The storage backend is injected: the browser passes nothing (localStorage is
 * the default), unit tests pass an in-memory fake — node has no localStorage.
 */
import { isWorkspace, type Workspace } from './workspace';

/** One saved connection preset. `name` is user-chosen — never the protocol's
 * agent-reported name (agentName at initialize; see CONTEXT.md). */
export type AgentProfile = {
  id: string;
  name: string;
  /** WebSocket endpoint of the ACP service — a field of the profile, never a
   * synonym for the profile itself. */
  url: string;
  /** Default 工作区 (ADR 0005): what new sessions with this agent use — a
   * local directory, or none; connect-time edits are written back here
   * (issue #2 spec). */
  workspace: Workspace;
};

/** localStorage-shaped backend; injectable for tests. */
export interface ProfileStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PROFILES_KEY = 'panda.profiles';

type ProfilesListener = (profiles: AgentProfile[]) => void;

/**
 * Live subscribers to the stored list. localStorage is the single source of
 * truth but it has two writers (the sidebar's profile CRUD and the
 * connection manager's connect-time write-back), so every write notifies —
 * a UI copy that never re-reads would silently diverge.
 */
const listeners = new Set<ProfilesListener>();

export function subscribeProfiles(listener: ProfilesListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyProfiles(storage: ProfileStorage): void {
  const current = loadProfiles(storage);
  for (const listener of listeners) listener(current);
}

function defaultStorage(): ProfileStorage {
  // Browser-only by construction: the UI is the only caller without injection.
  return globalThis.localStorage;
}

function isProfile(value: unknown): value is AgentProfile {
  if (typeof value !== 'object' || value === null) return false;
  const { id, name, url, workspace } = value as Record<string, unknown>;
  return (
    typeof id === 'string' && id.length > 0 &&
    typeof name === 'string' && name.length > 0 &&
    typeof url === 'string' && url.length > 0 &&
    isWorkspace(workspace)
  );
}

/** Best-effort removal of a poisoned key (#87): without it a malformed entry
 * survives every load and re-warns forever — the console is not a cleanup. */
function purgeProfiles(storage: ProfileStorage): void {
  try {
    storage.removeItem(PROFILES_KEY);
  } catch (err) {
    console.warn('[panda/profiles] could not purge malformed profiles storage', err);
  }
}

/** Loads all saved profiles; malformed storage or entries are dropped loudly
 * AND removed from storage (直接清理,不迁移 — #87 拍板), so the warning
 * fires once per bad entry instead of on every load. */
export function loadProfiles(storage: ProfileStorage = defaultStorage()): AgentProfile[] {
  let raw: string | null;
  try {
    raw = storage.getItem(PROFILES_KEY);
  } catch (err) {
    console.warn('[panda/profiles] could not read profiles', err);
    return [];
  }
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn('[panda/profiles] profiles storage is not an array — starting empty');
      purgeProfiles(storage);
      return [];
    }
    const valid = parsed.filter((entry) => {
      if (isProfile(entry)) return true;
      console.warn(`[panda/profiles] malformed profile dropped: ${JSON.stringify(entry)}`);
      return false;
    });
    if (valid.length !== parsed.length) {
      // 回写净化后的列表(不走 saveProfiles:它会再触发 notify→load 重入)
      try {
        storage.setItem(PROFILES_KEY, JSON.stringify(valid));
      } catch (err) {
        console.warn('[panda/profiles] could not persist cleaned profiles', err);
      }
    }
    return valid;
  } catch (err) {
    console.warn('[panda/profiles] could not parse profiles storage — starting empty', err);
    purgeProfiles(storage);
    return [];
  }
}

/** Persists the full list; failures warn but never throw (best-effort, like the
 * session persistence in useLiveSession). */
export function saveProfiles(profiles: AgentProfile[], storage: ProfileStorage = defaultStorage()): void {
  try {
    storage.setItem(PROFILES_KEY, JSON.stringify(profiles));
  } catch (err) {
    console.warn('[panda/profiles] could not persist profiles', err);
  }
  notifyProfiles(storage);
}

/** Updates editable profile fields and persists. Empty name/url strings are
 * ignored (neither can be blanked through this API — the settings editor
 * and the connect-time write-back share that guarantee). Returns the new
 * list; unknown ids leave the list unchanged (warned). */
export function updateProfileFields(
  id: string,
  fields: Partial<Pick<AgentProfile, 'name' | 'url' | 'workspace'>>,
  storage: ProfileStorage = defaultStorage(),
): AgentProfile[] {
  const profiles = loadProfiles(storage);
  const found = profiles.some((profile) => profile.id === id);
  if (!found) {
    console.warn(`[panda/profiles] write-back skipped: no profile ${id}`);
    return profiles;
  }
  const applied: Partial<Pick<AgentProfile, 'name' | 'url' | 'workspace'>> = {};
  if (typeof fields.name === 'string' && fields.name.trim().length > 0) applied.name = fields.name;
  if (typeof fields.url === 'string' && fields.url.trim().length > 0) applied.url = fields.url;
  if (fields.workspace !== undefined) applied.workspace = fields.workspace;
  const updated = profiles.map((profile) => (profile.id === id ? { ...profile, ...applied } : profile));
  saveProfiles(updated, storage);
  return updated;
}

export function newProfileId(): string {
  return globalThis.crypto.randomUUID();
}