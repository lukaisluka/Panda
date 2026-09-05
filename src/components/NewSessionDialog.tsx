import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ChevronRight, PlugZap } from 'lucide-react';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { LayoutContent } from '@astryxdesign/core/Layout';
import { Selector } from '@astryxdesign/core/Selector';
import { Spinner } from '@astryxdesign/core/Spinner';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { TextInput } from '@astryxdesign/core/TextInput';
import { usePanda } from '../store';
import { lastConnectionDefaults } from '../liveConnections';
import type { AgentProfile } from '../profiles';
import type { Workspace } from '../workspace';
import type { LiveSessionFacade } from '../useLiveSession';
import './NewSessionDialog.css';

/**
 * New-session picker (IA refactor phase 3): the entry that used to be
 * "connect, then 新建会话 on the foreground connection" — choosing the agent
 * IS creating the session. Connected agents start a session/new right away;
 * connecting ones show their progress; the rest connect first (a successful
 * connect establishes a fresh session by itself). 自定义地址 starts a
 * temporary direct connection, never a saved 配置.
 */
export function NewSessionDialog({ isOpen, onOpenChange, onStarted, live, profiles }: {
  isOpen: boolean;
  onOpenChange(open: boolean): void;
  onStarted(): void;
  live: LiveSessionFacade;
  profiles: AgentProfile[];
}) {
  // Per-profile slot status, as flat arrays of primitives so the selector's
  // snapshot is shallow-stable (object values would re-create every call and
  // loop useSyncExternalStore). A connect in progress updates its spinner
  // the moment the slot settles.
  const statuses = usePanda(
    useShallow((s) => profiles.map((profile) => s.connections[profile.id]?.connection.status ?? 'disconnected')),
  );
  const cwds = usePanda(useShallow((s) => profiles.map((profile) => s.connections[profile.id]?.connection.cwd ?? null)));

  const [customUrl, setCustomUrl] = useState(() => lastConnectionDefaults().url);
  const [customWorkspace, setCustomWorkspace] = useState<Workspace>(() => lastConnectionDefaults().workspace);
  const [showCustomErrors, setShowCustomErrors] = useState(false);
  const customErrors = customEndpointErrors({ url: customUrl, workspace: customWorkspace });
  // Astryx TextInput surfaces errors through its status object; they appear
  // only after a rejected submit, never while the user is still typing.
  const statusOf = (field: 'url' | 'path') =>
    showCustomErrors && customErrors[field] ? { type: 'error' as const, message: customErrors[field] } : undefined;

  const start = (action: () => void) => {
    action();
    onOpenChange(false);
    onStarted();
  };

  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} purpose="form" width={440}>
      <DialogHeader title="新建会话" subtitle="选择要对话的 agent" onOpenChange={onOpenChange} />
      <LayoutContent>
        <div className="nsd-list">
          {profiles.length === 0 && (
            <p className="nsd-hint">还没有 Agent 配置 — 在设置页添加,或用下方自定义地址临时直连。</p>
          )}
          {profiles.map((profile, index) => {
            const status = statuses[index] ?? 'disconnected';
            const cwd = cwds[index] ?? null;
            return (
              <button
                key={profile.id}
                type="button"
                className="nsd-agent"
                onClick={() =>
                  start(() =>
                    status === 'connected' && cwd ? live.newSession(cwd) : live.connectProfile(profile),
                  )
                }
                title={
                  status === 'connected'
                    ? `在 ${profile.name} 中新建会话`
                    : `连接 ${profile.name}(${profile.url})— 连接成功即进入新会话`
                }
              >
                <span className="nsd-agent-status">
                  {status === 'connecting' ? (
                    <Spinner size="sm" />
                  ) : status === 'connected' ? (
                    <StatusDot variant="success" label="已连接" />
                  ) : status === 'error' ? (
                    <StatusDot variant="error" label="连接错误" />
                  ) : (
                    <StatusDot variant="neutral" label="未连接" />
                  )}
                </span>
                <span className="nsd-agent-main">
                  <span className="truncate nsd-agent-name">{profile.name}</span>
                  <span className="truncate nsd-agent-meta">{profile.url}</span>
                </span>
                <ChevronRight size={14} className="nsd-agent-chevron" />
              </button>
            );
          })}
        </div>

        <div className="nsd-custom">
          <span className="nsd-custom-title">自定义地址</span>
          <p className="nsd-hint">临时直连,不保存为配置。</p>
          <TextInput
            label="端点地址"
            value={customUrl}
            onChange={setCustomUrl}
            placeholder="ws://host:port/acp"
            status={statusOf('url')}
          />
          <div className="nsd-custom-fields">
            <div className="nsd-custom-kind">
              <Selector
                label="工作区"
                isLabelHidden
                value={customWorkspace.kind}
                onChange={(kind) =>
                  setCustomWorkspace(kind === 'none' ? { kind: 'none' } : { kind: 'local-directory', path: '' })
                }
                options={[
                  { value: 'local-directory', label: '本机文件夹' },
                  { value: 'none', label: '无工作区' },
                ]}
                labelTooltip="工作区:新会话在 agent 侧的工作上下文(ADR 0005)"
              />
            </div>
            {customWorkspace.kind === 'local-directory' && (
              <div className="nsd-custom-path">
                <TextInput
                  label="工作区路径"
                  isLabelHidden
                  width="100%"
                  value={customWorkspace.path}
                  onChange={(path) => setCustomWorkspace({ kind: 'local-directory', path })}
                  placeholder="/absolute/path/on/the/agent"
                  status={statusOf('path')}
                />
              </div>
            )}
          </div>
          <Button
            variant="secondary"
            size="sm"
            width="100%"
            label="连接并开始"
            icon={<PlugZap size={12} />}
            clickAction={() => {
              if (customErrors.url || customErrors.path) {
                setShowCustomErrors(true);
                return;
              }
              start(() =>
                live.connectDirect(
                  customUrl.trim(),
                  customWorkspace.kind === 'local-directory'
                    ? { kind: 'local-directory', path: customWorkspace.path.trim() }
                    : customWorkspace,
                ),
              );
            }}
          />
        </div>
      </LayoutContent>
    </Dialog>
  );
}

/** Field-level validation for the custom-address form (unit-tested). */
export function customEndpointErrors(draft: { url: string; workspace: Workspace }): Partial<Record<'url' | 'path', string>> {
  const errors: Partial<Record<'url' | 'path', string>> = {};
  if (!draft.url.trim()) errors.url = '端点地址不能为空';
  if (draft.workspace.kind === 'local-directory' && !draft.workspace.path.trim()) errors.path = '本机文件夹需要路径';
  return errors;
}
