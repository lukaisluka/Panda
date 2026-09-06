/**
 * Agent 配置（issue #2, ADR 0001; issue #23, ADR 0005; issue #121): saved
 * connection presets — name + endpoint + default workspace, persisted to
 * localStorage per browser. The endpoint is one of two kinds: a WebSocket
 * URL, or a stdio command (spawned by a desktop host — architecture doc
 * §5.2's "配置是纯数据 command/args"). Sessions stay keyed by endpoint
 * (`panda.sessions:<endpoint>`, see profileEndpoint) and are NOT touched by
 * profile CRUD — deleting a profile never deletes remembered sessions.
 *
 * The storage backend is injected: the browser passes nothing (localStorage is
 * the default), unit tests pass an in-memory fake — node has no localStorage.
 */
import { isWorkspace, type Workspace } from './workspace';

/** One saved connection preset. `name` is user-chosen — never the protocol's
 * agent-reported name (agentName at initialize; see CONTEXT.md). */
export type AgentProfile =
  | { id: string; name: string; kind: 'websocket'; url: string; workspace: Workspace }
  | { id: string; name: string; kind: 'stdio'; command: string; args: string; workspace: Workspace };

/** The connection target a profile (or the custom-address form) reduces to —
 * the connection manager's currency (issue #121). Pure data: how a target is
 * reached is the transport's business, decided in liveConnections. */
export type LiveTarget =
  | { kind: 'websocket'; url: string }
  | { kind: 'stdio'; command: string; args: string };

/**
 * Whitespace-separated args in canonical form: trimmed, inner runs collapsed
 * to one space. The argv meaning is unchanged, but the endpoint string (and
 * with it the session-memory key) becomes independent of how the user spaced
 * the input.
 */
export function canonicalArgs(args: string): string {
  return args.trim().split(/\s+/).filter((part) => part.length > 0).join(' ');
}

export function profileToLiveTarget(profile: AgentProfile): LiveTarget {
  return profile.kind === 'websocket'
    ? { kind: 'websocket', url: profile.url.trim() }
    : { kind: 'stdio', command: profile.command.trim(), args: canonicalArgs(profile.args) };
}

/** stdio endpoints carry this prefix — no WebSocket URL can start with it. */
const STDIO_ENDPOINT_PREFIX = 'stdio: ';

/**
 * The endpoint string for a target: a WebSocket URL as-is, or
 * `stdio: <command> [args]` for local agents. One string serves three roles —
 * the per-endpoint session-memory key (liveConnections folds persistence by
 * ConnectionInfo.url), the sidebar/status display, and reconnect identity —
 * so it is derived in exactly one place.
 */
export function liveTargetEndpoint(target: LiveTarget): string {
  return target.kind === 'websocket'
    ? target.url
    : `${STDIO_ENDPOINT_PREFIX}${target.command}${target.args ? ` ${target.args}` : ''}`;
}

export function profileEndpoint(profile: AgentProfile): string {
  return liveTargetEndpoint(profileToLiveTarget(profile));
}

/** Whether an endpoint string names a stdio agent (vs a WebSocket URL). */
export function isStdioEndpoint(endpoint: string | null): boolean {
  return endpoint !== null && endpoint.startsWith(STDIO_ENDPOINT_PREFIX);
}

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
  const { id, name, workspace } = value as Record<string, unknown>;
  return (
    typeof id === 'string' && id.length > 0 &&
    typeof name === 'string' && name.length > 0 &&
    isWorkspace(workspace)
  );
}

/**
 * Validates one stored entry and upgrades it to the current schema. Legacy
 * entries (pre-#121, no `kind`) are websocket profiles by construction —
 * they are migrated, never dropped: dropping would delete a user's saved
 * endpoint on upgrade day. Returns null for genuinely malformed entries
 * (unknown kind, missing endpoint fields).
 */
function normalizeProfile(value: unknown): AgentProfile | null {
  if (!isProfile(value)) return null;
  const entry = value as Record<string, unknown> & { id: string; name: string; workspace: Workspace };
  if (entry.kind === undefined) {
    // Legacy shape: id/name/url/workspace. A missing/blank url was already
    // malformed before #121 — treat it the same as a fresh websocket entry
    // with no url: dropped, loudly, by the caller.
    return typeof entry.url === 'string' && entry.url.length > 0
      ? { id: entry.id, name: entry.name, kind: 'websocket', url: entry.url, workspace: entry.workspace }
      : null;
  }
  if (entry.kind === 'websocket') {
    return typeof entry.url === 'string' && entry.url.length > 0
      ? { id: entry.id, name: entry.name, kind: 'websocket', url: entry.url, workspace: entry.workspace }
      : null;
  }
  if (entry.kind === 'stdio') {
    // args defaults to '' when absent (hand-written configs); command is the
    // load-bearing field — without it there is nothing to spawn.
    return typeof entry.command === 'string' && entry.command.length > 0
      ? {
          id: entry.id,
          name: entry.name,
          kind: 'stdio',
          command: entry.command,
          args: typeof entry.args === 'string' ? entry.args : '',
          workspace: entry.workspace,
        }
      : null;
  }
  return null;
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
    const normalized: AgentProfile[] = [];
    let changed = false;
    for (const entry of parsed) {
      const profile = normalizeProfile(entry);
      if (profile === null) {
        console.warn(`[panda/profiles] malformed profile dropped: ${JSON.stringify(entry)}`);
        changed = true;
        continue;
      }
      if (profile !== entry) changed = true; // legacy entry upgraded to the #121 shape
      normalized.push(profile);
    }
    if (changed) {
      // 回写净化/迁移后的列表(不走 saveProfiles:它会再触发 notify→load 重入)
      try {
        storage.setItem(PROFILES_KEY, JSON.stringify(normalized));
      } catch (err) {
        console.warn('[panda/profiles] could not persist cleaned profiles', err);
      }
    }
    return normalized;
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

/**
 * Connect-time write-back patch: same-kind endpoint fields plus the shared
 * name/workspace. Fields of the other kind are applied nowhere — they warn
 * and are skipped, because a write-back always echoes the profile it
 * connected as. Endpoint-kind SWITCHING (websocket ↔ stdio) is the settings
 * editor's business and goes through `saveProfiles`, never this API.
 */
export type ProfileFieldPatch = {
  name?: string;
  workspace?: Workspace;
  /** websocket endpoint — applied to websocket profiles only. */
  url?: string;
  /** stdio endpoint — applied to stdio profiles only. args may be blanked. */
  command?: string;
  args?: string;
};

/** Updates editable profile fields and persists. Blank name/url/command
 * strings are ignored (endpoints and names can never be blanked through this
 * API — the settings editor and the connect-time write-back share that
 * guarantee; stdio args may legitimately become ''). Returns the new list;
 * unknown ids leave the list unchanged (warned). */
export function updateProfileFields(
  id: string,
  fields: ProfileFieldPatch,
  storage: ProfileStorage = defaultStorage(),
): AgentProfile[] {
  const profiles = loadProfiles(storage);
  const found = profiles.some((profile) => profile.id === id);
  if (!found) {
    console.warn(`[panda/profiles] write-back skipped: no profile ${id}`);
    return profiles;
  }
  const updated = profiles.map((profile) => {
    if (profile.id !== id) return profile;
    const applied: ProfileFieldPatch = {};
    if (typeof fields.name === 'string' && fields.name.trim().length > 0) applied.name = fields.name;
    if (fields.workspace !== undefined) applied.workspace = fields.workspace;
    if (typeof fields.url === 'string') {
      if (profile.kind === 'websocket' && fields.url.trim().length > 0) applied.url = fields.url;
      else if (profile.kind !== 'websocket') {
        console.warn(`[panda/profiles] write-back ignored url on a ${profile.kind} profile (${id})`);
      }
    }
    if (typeof fields.command === 'string' || typeof fields.args === 'string') {
      if (profile.kind !== 'stdio') {
        console.warn(`[panda/profiles] write-back ignored command/args on a ${profile.kind} profile (${id})`);
      } else {
        if (typeof fields.command === 'string' && fields.command.trim().length > 0) applied.command = fields.command;
        if (typeof fields.args === 'string') applied.args = fields.args;
      }
    }
    return { ...profile, ...applied } as AgentProfile;
  });
  saveProfiles(updated, storage);
  return updated;
}

export function newProfileId(): string {
  return globalThis.crypto.randomUUID();
}