import { useEffect, useState } from 'react';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Button } from '@astryxdesign/core/Button';
import { Spinner } from '@astryxdesign/core/Spinner';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import {
  Bot,
  BookmarkPlus,
  MessagesSquare,
  PlugZap,
  Plus,
  Settings,
  Trash2,
  Unplug,
  X,
} from 'lucide-react';
import {
  isConnectionBusy,
  isConnectionRunning,
  needsAttention,
  useConnectionOrder,
  usePanda,
  type ConnectionStatus,
  type SessionMode,
} from '../store';
import { isDirectConnectionId } from '../liveConnections';
import { effectiveCapability, PANDA_HOST_CAPABILITIES } from '../capabilities';
import type { AgentProfile } from '../profiles';
import { loadProfiles, newProfileId, saveProfiles, subscribeProfiles } from '../profiles';
import { navigate } from '../routes';
import { cwdToWorkspace, workspaceLabel } from '../workspace';
import type { LiveSessionFacade } from '../useLiveSession';
import { NewSessionDialog } from './NewSessionDialog';
import './Sidebar.css';

/**
 * Session-centered sidebar (IA refactor phase 3): every Agent 配置 renders as
 * a section — online ones with live sessions, offline ones as seeded
 * disconnected slots carrying the endpoint's remembered sessions (历史可见,
 * hover = 连接). Connection management lives in the settings page; the only
 * sidebar entry points are 新建会话 (picker dialog) and 添加 agent (settings).
 * 前台连接置顶, 其余按最近活动; each group row subscribes narrowly to its
 * own slot so a streaming connection only re-renders its own group.
 */
export function Sidebar({ mode, live, mobileOpen, onMobileClose }: {
  mode: SessionMode;
  live: LiveSessionFacade;
  mobileOpen: boolean;
  onMobileClose(): void;
}) {
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const orderedIds = useConnectionOrder();
  const [profiles, setProfiles] = useState<AgentProfile[]>(() => loadProfiles());
  // The settings page also writes profiles (CRUD) — storage is the single
  // source, the subscription keeps this copy from diverging.
  useEffect(() => subscribeProfiles(setProfiles), []);

  // Offline agent sections: seed a disconnected slot (remembered sessions
  // included) for every 配置, and drop slots whose 配置 was deleted —
  // remembered sessions live per-endpoint in storage and survive both.
  useEffect(() => {
    live.seedProfileSlots(profiles);
    const known = new Set(profiles.map((profile) => profile.id));
    for (const connectionId of Object.keys(usePanda.getState().connections)) {
      if (!isDirectConnectionId(connectionId) && !known.has(connectionId)) live.remove(connectionId);
    }
  }, [profiles, live]);

  const liveMode = mode === 'live';
  const activeConnectionId = usePanda((s) => s.activeConnectionId);
  const footerAgent = usePanda((s) =>
    s.mode === 'live'
      ? s.connections[s.activeConnectionId ?? '']?.connection.agentName ?? null
      : null,
  );

  return (
    <aside className={`sidebar ${mobileOpen ? 'sidebar--open' : ''}`}>
      <div className="sidebar-brand">
        <span className="sidebar-logo">🐼</span>
        Panda
        <span className="sidebar-brand-actions">
          <span className="sidebar-close">
            <IconButton
              variant="ghost"
              size="sm"
              icon={<X size={16} />}
              label="关闭导航"
              clickAction={onMobileClose}
            />
          </span>
        </span>
      </div>

      <div className="sidebar-sessions-head">
        <span className="sidebar-label">
          Sessions
        </span>
        <IconButton
          variant="ghost"
          size="sm"
          icon={<Plus size={13} />}
          label="新建会话"
          tooltip="选择 agent 开始新会话(可临时直连自定义地址)"
          clickAction={() => setNewSessionOpen(true)}
        />
      </div>
      <div className="sidebar-sessions">
        {!liveMode && (
          <div className="sidebar-demo-chip">
            <MessagesSquare size={13} className="sidebar-icon-faint" />
            <span className="truncate">重构 auth 校验</span>
          </div>
        )}
        <div className="sidebar-group-list">
          {orderedIds.map((connectionId) => (
            <ConnectionGroupRow
              key={connectionId}
              connectionId={connectionId}
              profile={profiles.find((entry) => entry.id === connectionId) ?? null}
              isActiveConnection={connectionId === activeConnectionId}
              live={live}
              onMobileClose={onMobileClose}
            />
          ))}
          {liveMode && orderedIds.length === 0 && (
            <div className="sidebar-empty">
              还没有 agent — 用下方「添加 agent」添加配置,或点上方 + 临时直连
            </div>
          )}
        </div>
      </div>

      <div className="sidebar-footer-block">
        <button
          type="button"
          className="sidebar-add-agent"
          onClick={() => {
            navigate('settings');
            onMobileClose();
          }}
        >
          <Plus size={13} />
          添加 agent
        </button>
        <div className="sidebar-footer">
          <Bot size={14} className="sidebar-footer-icon" />
          <span className="truncate">
            {liveMode
              ? footerAgent
                ? `${footerAgent} · live`
                : 'acp · live'
              : 'claude-code · replay'}
          </span>
          <IconButton
            variant="ghost"
            size="sm"
            icon={<Settings size={14} />}
            label="设置"
            tooltip="设置:Agent 配置、主题"
            clickAction={() => {
              navigate('settings');
              onMobileClose();
            }}
          />
        </div>
      </div>

      {newSessionOpen && (
        <NewSessionDialog
          isOpen
          onOpenChange={setNewSessionOpen}
          onStarted={onMobileClose}
          live={live}
          profiles={profiles}
        />
      )}
    </aside>
  );
}

/**
 * Saves a 临时直连's endpoint as an Agent 配置 (phase 4): the running
 * connection is deliberately NOT migrated — the 配置's seeded slot appears
 * ready for the next session, and the temporary one ends with its disconnect
 * as always. Default name is the endpoint's host:port.
 */
function saveDirectAsProfile(url: string, cwd: string | null): void {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) return;
  const workspace = cwdToWorkspace(cwd ?? '/');
  const defaultName = (() => {
    try {
      return new URL(trimmedUrl).host;
    } catch {
      return trimmedUrl;
    }
  })();
  const name = window.prompt('配置名称', defaultName)?.trim();
  if (!name) return; // cancelled or left blank
  saveProfiles([...loadProfiles(), { id: newProfileId(), name, url: trimmedUrl, workspace }]);
}

/** Astryx StatusDot per connection status; running overlays a pulse. */function SlotStatusDot({ status, running }: { status: ConnectionStatus; running: boolean }) {
  if (status === 'connecting') {
    return <Spinner size="sm" />;
  }
  if (status === 'error') {
    return <StatusDot variant="error" label="连接错误" />;
  }
  if (status === 'auth_required') {
    return <StatusDot variant="warning" label="需要登录" />;
  }
  if (status === 'connected') {
    return running
      ? <StatusDot variant="accent" isPulsing label="运行中" />
      : <StatusDot variant="success" label="已连接" />;
  }
  return <StatusDot variant="neutral" label="未连接" />;
}

/** One agent's section: header (status, indicators, hover actions), an
 * inline error recovery block when the connection failed, and the session
 * list (live or remembered). */
function ConnectionGroupRow({ connectionId, profile, isActiveConnection, live, onMobileClose }: {
  connectionId: string;
  profile: AgentProfile | null;
  isActiveConnection: boolean;
  live: LiveSessionFacade;
  onMobileClose(): void;
}) {
  // Whole-slot subscription: only THIS group re-renders when it streams.
  const slot = usePanda((s) => s.connections[connectionId]);
  const activeSessionId = usePanda((s) => s.activeSessionId);
  if (!slot) return null;

  const status = slot.connection.status;
  const connected = status === 'connected';
  const offline = status === 'disconnected';
  const running = isConnectionRunning(slot);
  const busy = isConnectionBusy(slot);
  const attention = needsAttention(slot);
  const title = profile?.name ?? slot.connection.url ?? connectionId;
  const isForegroundSession = (sessionId: string) => isActiveConnection && sessionId === activeSessionId;
  // Resume needs a retained session; seeded slots have none.
  const canResume = status === 'error' && slot.connection.sessionId !== null;

  const ordered = [...slot.sessions].sort((a, b) => {
    if (isForegroundSession(a.sessionId)) return -1;
    if (isForegroundSession(b.sessionId)) return 1;
    return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
  });

  return (
    <div className={`sidebar-group ${isActiveConnection ? 'sidebar-group--active' : ''}`}>
      <div className="sidebar-row">
        <button
          type="button"
          onClick={() => {
            live.foreground(connectionId);
            onMobileClose();
          }}
          title={slot.connection.url ?? title}
          className={`sidebar-connection-btn ${
            isActiveConnection ? 'sidebar-connection-btn--active' : ''
          } ${connected ? '' : 'sidebar-connection-btn--offline'}`}
        >
          <SlotStatusDot status={status} running={running} />
          <span className="truncate sidebar-row-title">{title}</span>
          {isDirectConnectionId(connectionId) && <span className="sidebar-temp-badge">临时</span>}
          {slot.connection.agentName && (
            <span className="truncate sidebar-row-sub">{slot.connection.agentName}</span>
          )}
          <span className="sidebar-row-end">
            {/* 需要关注 is a *background* connection indicator (CONTEXT.md):
                the foreground slot's issues are in plain sight (permission
                card, the error block below). */}
            {attention && !isActiveConnection && (
              <StatusDot variant="error" label="需要关注" tooltip="需要关注:未读完成 / 权限待处理 / 连接错误" />
            )}
          </span>
        </button>
        <div className="sidebar-hover-actions">
          {isDirectConnectionId(connectionId) && slot.connection.url && (
            <IconButton
              variant="ghost"
              size="sm"
              icon={<BookmarkPlus size={12} />}
              label="存为配置"
              tooltip="把当前端点与工作区保存为 Agent 配置(连接不打断)"
              clickAction={() => saveDirectAsProfile(slot.connection.url!, slot.connection.cwd)}
            />
          )}
          {(connected || status === 'connecting') && (
            <IconButton
              variant="ghost"
              size="sm"
              icon={<Unplug size={12} />}
              label="断开连接"
              tooltip={isDirectConnectionId(connectionId) ? '断开(临时直连到此结束)' : '断开(保留会话槽,可重连)'}
              clickAction={() => live.disconnect(connectionId)}
            />
          )}
          {offline && profile && (
            <IconButton
              variant="ghost"
              size="sm"
              icon={<PlugZap size={12} />}
              label="连接此配置"
              tooltip={`连接 ${profile.name}(${profile.url})`}
              clickAction={() => live.connectProfile(profile)}
            />
          )}
          {(status === 'error' || !offline) && (
            <IconButton
              variant="ghost"
              size="sm"
              icon={<Trash2 size={12} />}
              label="移除连接"
              tooltip="移除(断开并清除该连接的本地会话文档)"
              clickAction={() => {
                if (window.confirm(`移除连接「${title}」?其本地会话记录将被清除(按端点记忆的会话列表保留)。`)) {
                  live.remove(connectionId);
                }
              }}
            />
          )}
        </div>
      </div>
      {status === 'error' && slot.connection.error && (
        <div className="sidebar-conn-error">
          <p className="sidebar-conn-error-text" title={slot.connection.error}>
            {slot.connection.error}
          </p>
          <div className="sidebar-conn-error-actions">
            {canResume && (
              <Button
                variant="primary"
                size="sm"
                label="重连并恢复会话"
                tooltip="优先 resume 保留当前对话;agent 不支持时用 session/load 重建历史"
                clickAction={() => live.reconnectForeground({ resume: true })}
              />
            )}
            <Button
              variant={canResume ? 'secondary' : 'primary'}
              size="sm"
              label="重连"
              clickAction={() => live.reconnectForeground()}
            />
          </div>
        </div>
      )}
      {ordered.length > 0 && (
        <div className="sidebar-session-list">
          {ordered.map((entry) => {
            const foregroundSession = isForegroundSession(entry.sessionId);
            // Offline slots keep retained documents clickable (查看历史);
            // sessions never loaded locally stay inert until connected.
            const hasDoc = slot.docs[entry.sessionId] !== undefined;
            // Capability gating goes through the effective-capability
            // decision point (issue #22), never the raw declaration.
            const loadSession = effectiveCapability(
              'loadSession',
              slot.capabilities,
              PANDA_HOST_CAPABILITIES,
            );
            const canDelete = effectiveCapability('delete', slot.capabilities, PANDA_HOST_CAPABILITIES);
            const canSwitch = connected ? loadSession.available && !busy : hasDoc;
            const label = entry.title ?? `${workspaceLabel(entry.cwd)} · ${entry.sessionId.slice(-6)}`;
            return (
              <div key={entry.sessionId} className="sidebar-session">
                <button
                  disabled={foregroundSession || !canSwitch}
                  onClick={() => {
                    live.openSession(connectionId, entry.sessionId, entry.cwd);
                    onMobileClose();
                  }}
                  title={
                    foregroundSession
                      ? undefined
                      : !canSwitch && connected && busy
                        ? '等待当前回合或切换完成'
                        : !connected && !hasDoc
                          ? '连接后可查看/切换该会话'
                          : connected && !loadSession.available
                            ? loadSession.reason === 'unavailable-on-host'
                              ? '宿主暂不支持会话回放'
                              : 'agent 不支持历史回放(session/load)'
                            : entry.cwd
                  }
                  className={`sidebar-session-btn ${
                    foregroundSession
                      ? 'sidebar-session-btn--foreground'
                      : canSwitch
                        ? ''
                        : 'sidebar-session-btn--disabled'
                  }`}
                >
                  <MessagesSquare size={12} className="sidebar-icon-faint" />
                  <span className="truncate">{label}</span>
                </button>
                {canDelete.available && connected && !foregroundSession && !busy && (
                  <span className="sidebar-session-delete">
                    <IconButton
                      variant="ghost"
                      size="sm"
                      icon={<Trash2 size={12} />}
                      label="删除会话"
                      tooltip="删除会话(session/delete)"
                      clickAction={() => live.deleteSession(connectionId, entry.sessionId)}
                    />
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
