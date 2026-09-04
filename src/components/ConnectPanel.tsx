import { useEffect, useState } from 'react';
import { PlugZap, Plus, RotateCcw } from 'lucide-react';
import { Button } from '@astryxdesign/core/Button';
import { Selector } from '@astryxdesign/core/Selector';
import { Spinner } from '@astryxdesign/core/Spinner';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { TextInput } from '@astryxdesign/core/TextInput';
import { DEMO_CONNECTION_ID, useActiveConnection, usePanda, type SessionMode } from '../store';
import { isDirectConnectionId, lastConnectionDefaults } from '../liveConnections';
import { newProfileId, saveProfiles, type AgentProfile } from '../profiles';
import { cwdToWorkspace, type Workspace } from '../workspace';
import type { LiveSessionFacade } from '../useLiveSession';
import './ConnectPanel.css';

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

  const canResume = connection.status === 'error' && connection.sessionId !== null;
  const reconnectLabel = foregroundProfile
    ? `连接 ${foregroundProfile.name}`
    : '重连';
  // 无工作区 needs no path (ADR 0005); a local directory always does.
  const pathReady = workspace.kind === 'none' || workspace.path.trim().length > 0;

  return (
    <div className="connect-panel">
      <div className="connect-label">
        ACP 连接
      </div>

      {connection.status === 'connected' ? (
        <div className="connect-row">
          <span className="connect-agent">
            <StatusDot variant="success" label="已连接" />
            <span className="truncate">{connection.agentName}</span>
          </span>
          <span className="connect-version">
            v{connection.protocolVersion}
          </span>
        </div>
      ) : connection.status === 'connecting' ? (
        <div className="connect-connecting">
          <Spinner size="sm" />
          连接中…
        </div>
      ) : (
        <>
          {connection.status === 'error' && connection.error && (
            <p className="connect-error" title={connection.error}>
              {connection.error}
            </p>
          )}
          {reconnectableId !== null && canResume && (
            <Button
              className="connect-button--resume"
              variant="primary"
              size="sm"
              width="100%"
              label="重连并恢复会话"
              icon={<RotateCcw size={12} />}
              clickAction={() => live.reconnectForeground({ resume: true, url, workspace })}
              tooltip="优先 resume 保留当前对话；agent 不支持时用 session/load 重建历史"
            />
          )}
          <TextInput
            className="connect-input"
            label="端点地址"
            isLabelHidden
            value={url}
            onChange={setUrl}
            placeholder="ws://host:port/acp"
          />
          <div className="connect-fields">
            {/* Astryx Selector owns its own width/geometry — the Phase-1
                "white capsule" squash (w-28 losing to w-full in generated
                CSS order) dies here structurally, not by class ordering. */}
            <div className="connect-kind">
              <Selector
                label="工作区"
                isLabelHidden
                value={workspace.kind}
                onChange={(kind) =>
                  setWorkspace(kind === 'none' ? { kind: 'none' } : { kind: 'local-directory', path: '' })
                }
                options={[
                  { value: 'local-directory', label: '本机文件夹' },
                  { value: 'none', label: '无工作区' },
                ]}
                labelTooltip="工作区：新会话在 agent 侧的工作上下文（ADR 0005）"
              />
            </div>
            {workspace.kind === 'local-directory' && (
              <div className="connect-path">
                <TextInput
                  className="connect-input"
                  label="工作区路径"
                  isLabelHidden
                  width="100%"
                  value={workspace.path}
                  onChange={(path) => setWorkspace({ kind: 'local-directory', path })}
                  placeholder="/absolute/path/on/the/agent"
                />
              </div>
            )}
          </div>
          <Button
            className="connect-button--submit"
            variant="primary"
            size="sm"
            width="100%"
            label={reconnectableId !== null ? (canResume ? '新会话连接' : reconnectLabel) : '连接'}
            icon={<PlugZap size={12} />}
            isDisabled={!url.trim() || !pathReady}
            clickAction={() =>
              reconnectableId !== null
                ? live.reconnectForeground({ url, workspace })
                : live.connectDirect(url, workspace)
            }
            tooltip={
              reconnectableId !== null
                ? foregroundProfile
                  ? `连接 ${foregroundProfile.name}；修改的地址/工作区将在连接成功时写回该配置`
                  : '重新连接此前台直连'
                : '开始一条临时直连（不保存为配置）'
            }
          />
          {reconnectableId === null && !naming && (
            <Button
              className="connect-button"
              variant="secondary"
              size="sm"
              width="100%"
              label="存为 Agent 配置"
              icon={<Plus size={12} />}
              isDisabled={!url.trim() || !pathReady}
              clickAction={() => {
                setNaming(true);
                setNewName('');
              }}
              tooltip="把当前地址和工作区保存为一条配置，之后在侧栏一键连接"
            />
          )}
          {reconnectableId === null && naming && (
            <div className="connect-naming">
              <div className="connect-path">
                <TextInput
                  label="配置名称"
                  isLabelHidden
                  value={newName}
                  onChange={setNewName}
                  placeholder="配置名称，如「Mock Agent」"
                  hasAutoFocus
                  onEnter={saveAsProfile}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setNaming(false);
                  }}
                />
              </div>
              <Button
                variant="primary"
                size="sm"
                label="保存"
                isDisabled={!newName.trim()}
                clickAction={saveAsProfile}
              />
              <Button
                variant="ghost"
                size="sm"
                label="取消"
                clickAction={() => setNaming(false)}
              />
            </div>
          )}
          {reconnectableId === null && profiles.length > 0 && !naming && (
            <p className="connect-note">
              配置的连接 / 删除在上方 Sessions 分组行
            </p>
          )}
        </>
      )}

      <Button
        className="connect-button"
        variant="ghost"
        size="sm"
        width="100%"
        label={mode === 'demo' ? '重放 demo' : '回到 demo 回放'}
        icon={<RotateCcw size={11} />}
        clickAction={onReplayDemo}
      />
    </div>
  );
}
