import { useEffect, useState } from 'react';
import { Loader2, PlugZap, Plus, RotateCcw } from 'lucide-react';
import { DEMO_CONNECTION_ID, useActiveConnection, usePanda, type SessionMode } from '../store';
import { isDirectConnectionId, lastConnectionDefaults } from '../liveConnections';
import { newProfileId, saveProfiles, type AgentProfile } from '../profiles';
import { cwdToWorkspace, type Workspace } from '../workspace';
import type { LiveSessionFacade } from '../useLiveSession';

/** A profile click in the sidebar asks the form to adopt these values. */
export type FormPrefill = { url: string; workspace: Workspace; nonce: number };

/**
 * Connect surface (issue #21). Two shapes:
 *
 * - A foreground slot that is not connected (profile slot, 直连 slot):
 *   the form targets THAT slot — 连接 reconnects it, and edited url/cwd are
 *   written back to the 配置 on success (配置编辑静默生效于下次连接). For a
 *   retained session after an error, 恢复会话 resumes the transcript.
 * - No reconnectable foreground (demo mode / no foreground): the form
 *   starts a 临时直连 and can save the endpoint as an Agent 配置.
 *
 * Per-connection lifecycle (断开/移除/切前台) lives on the sidebar's group
 * rows. Panda is a pure protocol client: the form asks where the service
 * listens and which 工作区 sessions should use — a local directory on the
 * agent's side, or 无工作区 for agents that don't work in one (ADR 0005).
 * Whoever started the ACP service owns the agent process, Panda never spawns
 * one.
 */
export function ConnectPanel({ mode, profiles, onProfilesChange, prefill, live, onReplayDemo }: {
  mode: SessionMode;
  profiles: AgentProfile[];
  onProfilesChange(profiles: AgentProfile[]): void;
  prefill: FormPrefill | null;
  live: LiveSessionFacade;
  onReplayDemo(): void;
}) {
  const [url, setUrl] = useState(() => lastConnectionDefaults().url);
  const [workspace, setWorkspace] = useState<Workspace>(() => lastConnectionDefaults().workspace);
  const [naming, setNaming] = useState(false);
  const [newName, setNewName] = useState('');

  const connection = useActiveConnection();
  const activeId = usePanda((s) => s.activeConnectionId);

  // A foreground slot the form can reconnect. Demo mode keeps the anonymous
  // form: demo only switches the display layer and must not touch slots.
  const reconnectableId =
    mode === 'live' && activeId !== null && activeId !== DEMO_CONNECTION_ID ? activeId : null;
  const foregroundProfile =
    reconnectableId !== null && !isDirectConnectionId(reconnectableId)
      ? profiles.find((profile) => profile.id === reconnectableId) ?? null
      : null;

  // The form adopts the foreground slot's endpoint values (and a sidebar
  // prefill) so it always shows what the user is looking at. Keyed on slot
  // identity / prefill nonce only — a re-render mid-edit must not clobber
  // the user's typing.
  useEffect(() => {
    if (prefill) {
      setUrl(prefill.url);
      setWorkspace(prefill.workspace);
    }
  }, [prefill]);
  useEffect(() => {
    if (reconnectableId !== null) {
      setUrl(connection.url ?? '');
      // The slot remembers the derived cwd it last used; `/` reads back as
      // 无工作区 (ADR 0005).
      setWorkspace(cwdToWorkspace(connection.cwd ?? ''));
      setNaming(false);
    }
    // Deliberately keyed on slot identity only: adopting on every url/cwd
    // change would clobber the user's in-progress edits.
  }, [reconnectableId]);

  const saveAsProfile = () => {
    const name = newName.trim();
    const trimmedUrl = url.trim();
    const normalizedWorkspace: Workspace =
      workspace.kind === 'local-directory'
        ? { kind: 'local-directory', path: workspace.path.trim() }
        : workspace;
    if (!name || !trimmedUrl || normalizedWorkspace.kind === 'local-directory' && !normalizedWorkspace.path) return;
    const created: AgentProfile = { id: newProfileId(), name, url: trimmedUrl, workspace: normalizedWorkspace };
    const next = [...profiles, created];
    saveProfiles(next);
    onProfilesChange(next);
    setNaming(false);
    setNewName('');
  };

  const inputClass =
    'w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-fg outline-none placeholder:text-faint focus:border-accent/40';
  const actionClass =
    'flex items-center justify-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted transition-colors hover:border-accent/50 hover:text-accent';
  const primaryClass =
    'flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-medium text-bg transition-colors hover:brightness-110 disabled:opacity-40';

  const canResume = connection.status === 'error' && connection.sessionId !== null;
  const reconnectLabel = foregroundProfile
    ? `连接 ${foregroundProfile.name}`
    : '重连';
  // 无工作区 needs no path (ADR 0005); a local directory always does.
  const pathReady = workspace.kind === 'none' || workspace.path.trim().length > 0;

  return (
    <div className="mx-3 mb-3 rounded-xl border border-border bg-raised/50 p-3">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-faint">
        ACP 连接
      </div>

      {connection.status === 'connected' ? (
        <div className="flex items-center justify-between">
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
            <span className="truncate">{connection.agentName}</span>
          </span>
          <span className="shrink-0 font-mono text-[11px] text-faint">
            v{connection.protocolVersion}
          </span>
        </div>
      ) : connection.status === 'connecting' ? (
        <div className="flex items-center gap-2 py-1 text-xs text-muted">
          <Loader2 size={13} className="animate-spin text-accent" />
          连接中…
        </div>
      ) : (
        <>
          {connection.status === 'error' && connection.error && (
            <p className="mb-2 break-words text-[11px] leading-4 text-danger" title={connection.error}>
              {connection.error}
            </p>
          )}
          {reconnectableId !== null && canResume && (
            <button
              className={`${primaryClass} mb-2`}
              onClick={() => live.reconnectForeground({ resume: true, url, workspace })}
              title="优先 resume 保留当前对话；agent 不支持时用 session/load 重建历史"
            >
              <RotateCcw size={12} />
              重连并恢复会话
            </button>
          )}
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="ws://host:port/acp"
            spellCheck={false}
            className={`${inputClass} font-mono text-[13px]`}
          />
          <div className="mt-2 flex gap-2">
            <select
              value={workspace.kind}
              onChange={(e) =>
                setWorkspace(e.target.value === 'none' ? { kind: 'none' } : { kind: 'local-directory', path: '' })
              }
              className={`${inputClass} w-28 shrink-0 text-xs`}
              title="工作区：新会话在 agent 侧的工作上下文（ADR 0005）"
            >
              <option value="local-directory">本机文件夹</option>
              <option value="none">无工作区</option>
            </select>
            {workspace.kind === 'local-directory' && (
              <input
                value={workspace.path}
                onChange={(e) => setWorkspace({ kind: 'local-directory', path: e.target.value })}
                placeholder="/absolute/path/on/the/agent"
                spellCheck={false}
                className={`${inputClass} font-mono text-[13px]`}
              />
            )}
          </div>
          <button
            className={`${primaryClass} mt-2.5`}
            disabled={!url.trim() || !pathReady}
            onClick={() =>
              reconnectableId !== null
                ? live.reconnectForeground({ url, workspace })
                : live.connectDirect(url, workspace)
            }
            title={
              reconnectableId !== null
                ? foregroundProfile
                  ? `连接 ${foregroundProfile.name}；修改的地址/工作区将在连接成功时写回该配置`
                  : '重新连接此前台直连'
                : '开始一条临时直连（不保存为配置）'
            }
          >
            <PlugZap size={12} />
            {reconnectableId !== null ? (canResume ? '新会话连接' : reconnectLabel) : '连接'}
          </button>
          {reconnectableId === null && !naming && (
            <button
              className={`${actionClass} mt-2`}
              disabled={!url.trim() || !pathReady}
              onClick={() => {
                setNaming(true);
                setNewName('');
              }}
              title="把当前地址和工作区保存为一条配置，之后在侧栏一键连接"
            >
              <Plus size={12} />
              存为 Agent 配置
            </button>
          )}
          {reconnectableId === null && naming && (
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
          {reconnectableId === null && profiles.length > 0 && !naming && (
            <p className="mt-2 text-[10px] leading-3 text-faint">
              配置的连接 / 删除在上方 Sessions 分组行
            </p>
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
