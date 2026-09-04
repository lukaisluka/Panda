import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Selector } from '@astryxdesign/core/Selector';
import { Spinner } from '@astryxdesign/core/Spinner';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import {
  Bot,
  MessagesSquare,
  Palette,
  Plus,
  PlugZap,
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
import { effectiveCapability, PANDA_HOST_CAPABILITIES } from '../capabilities';
import type { AgentProfile } from '../profiles';
import { loadProfiles, saveProfiles, subscribeProfiles } from '../profiles';
import { isThemeId, loadThemeId, saveThemeId, subscribeTheme, THEMES } from '../theme';
import { workspaceDisplay, workspaceLabel } from '../workspace';
import { ConnectPanel, type FormPrefill } from './ConnectPanel';
import type { LiveSessionFacade } from '../useLiveSession';
import './Sidebar.css';

/**
 * Grouped sidebar (issue #21, ADR 0002): every connection slot is a group
 * with its own sessions beneath — 前台连接置顶, 其余按最近活动. Unslotted
 * Agent 配置 render as dormant rows (click = 预览, hover = 连接). Each group
 * row subscribes narrowly to its own slot so a streaming connection only
 * re-renders its own group, not the whole sidebar.
 */
export function Sidebar({ mode, live, onReplayDemo, mobileOpen, onMobileClose }: {
  mode: SessionMode;
  live: LiveSessionFacade;
  onReplayDemo(): void;
  mobileOpen: boolean;
  onMobileClose(): void;
}) {
  const [prefill, setPrefill] = useState<FormPrefill | null>(null);
  const orderedIds = useConnectionOrder();
  // Slotted profile ids — the profiles without a slot render as dormant rows.
  const slottedIds = usePanda(useShallow((s) => Object.keys(s.connections)));
  const [profiles, setProfiles] = useState<AgentProfile[]>(() => loadProfiles());
  // The connection manager also writes profiles (connect-time url/cwd
  // write-back) — storage is the single source, the subscription keeps this
  // copy from diverging.
  useEffect(() => subscribeProfiles(setProfiles), []);
  // Theme choice: same single-source contract — main.tsx's <Theme> anchor
  // re-renders off this subscription when the picker saves (#32 Phase 4).
  const [themeId, setThemeId] = useState(loadThemeId);
  useEffect(() => subscribeTheme(setThemeId), []);

  const liveMode = mode === 'live';
  const activeConnectionId = usePanda((s) => s.activeConnectionId);
  const foregroundCwd = usePanda((s) =>
    s.activeConnectionId ? s.connections[s.activeConnectionId]?.connection.cwd ?? null : null,
  );
  const foregroundConnected = usePanda(
    (s) => (s.activeConnectionId ? s.connections[s.activeConnectionId]?.connection.status : undefined) === 'connected',
  );
  const foregroundBusy = usePanda((s) => {
    const slot = s.activeConnectionId ? s.connections[s.activeConnectionId] : undefined;
    return !!slot && isConnectionBusy(slot);
  });
  const footerAgent = usePanda((s) =>
    s.mode === 'live'
      ? s.connections[s.activeConnectionId ?? '']?.connection.agentName ?? null
      : null,
  );

  const dormantProfiles = profiles.filter((profile) => !slottedIds.includes(profile.id));

  const previewProfile = (profile: AgentProfile) => {
    // Live mode: the manager seeds a disconnected slot with the endpoint's
    // remembered sessions and foregrounds it; demo mode only prefills.
    live.previewProfile(profile);
    setPrefill({ url: profile.url, workspace: profile.workspace, nonce: Date.now() });
  };

  return (
    <aside className={`sidebar ${mobileOpen ? 'sidebar--open' : ''}`}>
      <div className="sidebar-brand">
        <span className="sidebar-logo">🐼</span>
        Panda
        <span className="sidebar-close">
          <IconButton
            variant="ghost"
            size="sm"
            icon={<X size={16} />}
            label="关闭导航"
            clickAction={onMobileClose}
          />
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
          isDisabled={!liveMode || !foregroundConnected || !foregroundCwd || foregroundBusy}
          tooltip={
            liveMode && foregroundConnected && foregroundCwd && !foregroundBusy
              ? '在前台连接新建会话（session/new）'
              : foregroundBusy
                ? '等待当前回合或切换完成'
                : '连接 agent 后可新建会话'
          }
          clickAction={() => {
            if (foregroundCwd) live.newSession(foregroundCwd);
            onMobileClose();
          }}
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
          {dormantProfiles.map((profile) => (
            <DormantProfileRow
              key={profile.id}
              profile={profile}
              live={live}
              onPreview={previewProfile}
              onDelete={() => {
                // Sessions are keyed by endpoint, not by profile — they survive this.
                const next = profiles.filter((entry) => entry.id !== profile.id);
                saveProfiles(next);
                setProfiles(next);
              }}
              onMobileClose={onMobileClose}
            />
          ))}
          {liveMode && orderedIds.length === 0 && dormantProfiles.length === 0 && (
            <div className="sidebar-empty">暂无连接或配置 — 在下方连接 ACP 服务</div>
          )}
        </div>
      </div>

      <div className="sidebar-footer-block">
        <ConnectPanel
          mode={mode}
          profiles={profiles}
          onProfilesChange={setProfiles}
          prefill={prefill}
          live={live}
          onReplayDemo={() => {
            onReplayDemo();
            onMobileClose();
          }}
        />
        <div className="sidebar-theme-picker">
          <Palette size={14} className="sidebar-footer-icon" />
          <div className="sidebar-theme-select">
            <Selector
              label="主题"
              isLabelHidden
              value={themeId}
              onChange={(value) => {
                if (isThemeId(value)) saveThemeId(value);
              }}
              options={THEMES.map((choice) => ({ value: choice.id, label: choice.label }))}
              labelTooltip="主题：Astryx 官方主题（7 个），随时切换，自动记住选择"
            />
          </div>
        </div>
        <div className="sidebar-footer">
          <Bot size={14} className="sidebar-footer-icon" />
          <span className="truncate">
            {liveMode
              ? footerAgent
                ? `${footerAgent} · live`
                : 'acp · live'
              : 'claude-code · replay'}
          </span>
        </div>
      </div>
    </aside>
  );
}

/** Astryx StatusDot per connection status; running overlays a pulse. */
function SlotStatusDot({ status, running }: { status: ConnectionStatus; running: boolean }) {
  if (status === 'connecting') {
    return <Spinner size="sm" />;
  }
  if (status === 'error') {
    return <StatusDot variant="error" label="连接错误" />;
  }
  if (status === 'connected') {
    return running
      ? <StatusDot variant="accent" isPulsing label="运行中" />
      : <StatusDot variant="success" label="已连接" />;
  }
  return <StatusDot variant="neutral" label="未连接" />;
}

/** One connection's group: header (status, indicators, hover actions) + sessions. */
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
  const running = isConnectionRunning(slot);
  const busy = isConnectionBusy(slot);
  const attention = needsAttention(slot);
  const title = profile?.name ?? slot.connection.url ?? connectionId;
  const isForegroundSession = (sessionId: string) => isActiveConnection && sessionId === activeSessionId;

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
          {slot.connection.agentName && (
            <span className="truncate sidebar-row-sub">{slot.connection.agentName}</span>
          )}
          <span className="sidebar-row-end">
            {/* 需要关注 is a *background* connection indicator (CONTEXT.md):
                the foreground slot's issues are in plain sight (permission
                card, error text in the connect panel). */}
            {attention && !isActiveConnection && (
              <StatusDot variant="error" label="需要关注" tooltip="需要关注：未读完成 / 权限待处理 / 连接错误" />
            )}
          </span>
        </button>
        <div className="sidebar-hover-actions">
          {(connected || status === 'connecting') && (
            <IconButton
              variant="ghost"
              size="sm"
              icon={<Unplug size={12} />}
              label="断开连接"
              tooltip="断开（保留会话槽，可重连）"
              clickAction={() => live.disconnect(connectionId)}
            />
          )}
          <IconButton
            variant="ghost"
            size="sm"
            icon={<Trash2 size={12} />}
            label="移除连接"
            tooltip="移除（断开并清除该连接的本地会话文档）"
            clickAction={() => {
              const label = profile?.name ?? slot.connection.url ?? connectionId;
              if (window.confirm(`移除连接「${label}」？其本地会话记录将被清除（按端点记忆的会话列表保留）。`)) {
                live.remove(connectionId);
              }
            }}
          />
        </div>
      </div>
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
                              : 'agent 不支持历史回放（session/load）'
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
                      tooltip="删除会话（session/delete）"
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

/** An Agent 配置 without a connection slot: click = 预览, hover = 连接/删除. */
function DormantProfileRow({ profile, live, onPreview, onDelete, onMobileClose }: {
  profile: AgentProfile;
  live: LiveSessionFacade;
  onPreview(profile: AgentProfile): void;
  onDelete(): void;
  onMobileClose(): void;
}) {
  return (
    <div className="sidebar-row">
      <button
        type="button"
        onClick={() => {
          onPreview(profile);
          onMobileClose();
        }}
        title={`${profile.url} · ${workspaceDisplay(profile.workspace)}`}
        className="sidebar-dormant-btn"
      >
        <span className="sidebar-dormant-dot" />
        <span className="truncate">{profile.name}</span>
      </button>
      <div className="sidebar-hover-actions">
        <IconButton
          variant="ghost"
          size="sm"
          icon={<PlugZap size={12} />}
          label="连接此配置"
          tooltip={`连接 ${profile.name}（${profile.url}）`}
          clickAction={() => {
            live.connectProfile(profile);
            onMobileClose();
          }}
        />
        <IconButton
          variant="ghost"
          size="sm"
          icon={<Trash2 size={12} />}
          label="删除配置"
          tooltip="删除这条配置（不影响该端点已记忆的会话）"
          clickAction={onDelete}
        />
      </div>
    </div>
  );
}
