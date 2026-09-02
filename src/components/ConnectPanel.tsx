import { useEffect, useState } from 'react';
import { Loader2, PlugZap, Plus, RotateCcw, Trash2, Unplug } from 'lucide-react';
import type { ConnectionInfo, SessionMode } from '../store';
import { lastConnectionDefaults, type ConnectOptions } from '../useLiveSession';
import { loadProfiles, newProfileId, saveProfiles, type AgentProfile } from '../profiles';

/**
 * Connection surface for the live ACP service. Panda is a pure protocol
 * client: this form only asks where the service listens and which working
 * directory the session should use — whoever started the ACP service owns
 * the agent process, Panda never spawns one.
 *
 * Agent 配置 (issue #2): saved presets of name + endpoint + default cwd.
 * Selecting one prefills the (editable) form; connect-time edits are
 * written back to the profile on successful connect — that is what
 * "default working directory" means. Management is select / save-as /
 * delete, no edit dialog. With zero profiles saved the form behaves
 * exactly like the pre-profile one.
 */
export function ConnectPanel({ connection, mode, onConnect, onSelectProfile, onDisconnect, onReplayDemo }: {
  connection: ConnectionInfo;
  mode: SessionMode;
  onConnect(url: string, cwd: string, opts?: ConnectOptions): void;
  onSelectProfile(profile: AgentProfile): void;
  onDisconnect(): void;
  onReplayDemo(): void;
}) {
  const [url, setUrl] = useState(() => lastConnectionDefaults().url);
  const [cwd, setCwd] = useState(() => lastConnectionDefaults().cwd);
  const [profiles, setProfiles] = useState<AgentProfile[]>(() => loadProfiles());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [newName, setNewName] = useState('');

  // The form reappears after a disconnect — re-read profiles so a
  // connect-time write-back (made in useLiveSession) is reflected here.
  const formVisible = connection.status !== 'connected' && connection.status !== 'connecting';
  useEffect(() => {
    if (formVisible) setProfiles(loadProfiles());
  }, [formVisible]);

  const selected = profiles.find((profile) => profile.id === selectedId) ?? null;

  const selectProfile = (id: string) => {
    if (id === '') {
      setSelectedId(null);
      return;
    }
    const profile = profiles.find((entry) => entry.id === id);
    if (!profile) return;
    setSelectedId(id);
    setUrl(profile.url);
    setCwd(profile.cwd);
    onSelectProfile(profile);
  };

  const saveAsProfile = () => {
    const name = newName.trim();
    const trimmedUrl = url.trim();
    const trimmedCwd = cwd.trim();
    if (!name || !trimmedUrl || !trimmedCwd) return;
    const created: AgentProfile = { id: newProfileId(), name, url: trimmedUrl, cwd: trimmedCwd };
    const next = [...profiles, created];
    saveProfiles(next);
    setProfiles(next);
    setSelectedId(created.id);
    setNaming(false);
    setNewName('');
  };

  const deleteSelected = () => {
    if (selectedId === null) return;
    // Sessions are keyed by endpoint, not by profile — they survive this.
    const next = profiles.filter((profile) => profile.id !== selectedId);
    saveProfiles(next);
    setProfiles(next);
    setSelectedId(null);
  };

  const inputClass =
    'w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-fg outline-none placeholder:text-faint focus:border-accent/40';
  const actionClass =
    'flex items-center justify-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted transition-colors hover:border-accent/50 hover:text-accent';
  const primaryClass =
    'flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-medium text-bg transition-colors hover:brightness-110 disabled:opacity-40';
  const canResume = connection.status === 'error' && connection.sessionId !== null;

  return (
    <div className="mx-3 mb-3 rounded-xl border border-border bg-raised/50 p-3">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-faint">
        ACP 连接
      </div>

      {connection.status === 'connected' ? (
        <>
          <div className="flex items-center justify-between">
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
              <span className="truncate">{connection.agentName}</span>
            </span>
            <span className="shrink-0 font-mono text-[10px] text-faint">
              v{connection.protocolVersion}
            </span>
          </div>
          <div className="mt-1 truncate font-mono text-[10px] text-faint" title={connection.url ?? undefined}>
            {connection.url}
          </div>
          <div className="mt-2.5 flex gap-2">
            <button className={`${actionClass} flex-1`} onClick={onDisconnect}>
              <Unplug size={12} />
              断开
            </button>
          </div>
        </>
      ) : connection.status === 'connecting' ? (
        <div className="flex items-center gap-2 py-1 text-xs text-muted">
          <Loader2 size={13} className="animate-spin text-accent" />
          连接中…
        </div>
      ) : (
        <>
          {profiles.length > 0 && (
            <div className="flex gap-2">
              <select
                value={selectedId ?? ''}
                onChange={(e) => selectProfile(e.target.value)}
                className={`${inputClass} text-xs`}
                aria-label="Agent 配置"
                title="选择一条保存的配置；连接成功后地址/目录的改动会写回该配置"
              >
                <option value="">直接连接（不使用配置）</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
              {selected !== null && (
                <button
                  className={`${actionClass} shrink-0 px-2`}
                  onClick={deleteSelected}
                  aria-label="删除配置"
                  title="删除这条配置（不影响该端点已记忆的会话）"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          )}
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="ws://host:port/acp"
            spellCheck={false}
            className={`${inputClass} font-mono text-[11px] ${profiles.length > 0 ? 'mt-2' : ''}`}
          />
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="/absolute/path/to/project"
            spellCheck={false}
            className={`${inputClass} mt-2 font-mono text-[11px]`}
          />
          {connection.status === 'error' && connection.error && (
            <p className="mt-2 break-words text-[11px] leading-4 text-danger" title={connection.error}>
              {connection.error}
            </p>
          )}
          {canResume && (
            <button
              className={`${primaryClass} mt-2.5`}
              onClick={() => onConnect(url, cwd, { resume: true, profileId: selectedId })}
              title="优先 resume 保留当前对话；agent 不支持时用 session/load 重建历史"
            >
              <RotateCcw size={12} />
              重连并恢复会话
            </button>
          )}
          <button
            className={`${primaryClass} ${canResume ? 'mt-2' : 'mt-2.5'}`}
            disabled={!url.trim() || !cwd.trim()}
            onClick={() => onConnect(url, cwd, { profileId: selectedId })}
          >
            <PlugZap size={12} />
            {canResume ? '新会话连接' : '连接'}
          </button>
          {!naming ? (
            <button
              className={`${actionClass} mt-2`}
              disabled={!url.trim() || !cwd.trim()}
              onClick={() => {
                setNaming(true);
                setNewName(selected?.name ?? '');
              }}
              title="把当前地址和目录保存为一条配置，之后一键选中"
            >
              <Plus size={12} />
              存为 Agent 配置
            </button>
          ) : (
            <div className="mt-2 flex gap-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="配置名称，如「Mock Agent」"
                autoFocus
                spellCheck={false}
                className={inputClass}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveAsProfile();
                  if (e.key === 'Escape') setNaming(false);
                }}
              />
              <button
                className={`${primaryClass} w-auto shrink-0 px-3`}
                disabled={!newName.trim()}
                onClick={saveAsProfile}
              >
                保存
              </button>
              <button className={`${actionClass} shrink-0`} onClick={() => setNaming(false)}>
                取消
              </button>
            </div>
          )}
        </>
      )}

      <button
        className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] text-faint transition-colors hover:text-muted"
        onClick={onReplayDemo}
      >
        <RotateCcw size={11} />
        {mode === 'demo' ? '重放 demo' : '回到 demo 回放'}
      </button>
    </div>
  );
}
