import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  Bot,
  Loader2,
  MessagesSquare,
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
import type { AgentProfile } from '../profiles';
import { loadProfiles, saveProfiles, subscribeProfiles } from '../profiles';
import { ConnectPanel, type FormPrefill } from './ConnectPanel';
import type { LiveSessionFacade } from '../useLiveSession';

const basename = (cwd: string) => cwd.split('/').filter(Boolean).at(-1) ?? cwd;

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
    setPrefill({ url: profile.url, cwd: profile.cwd, nonce: Date.now() });
  };

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-30 flex w-60 flex-col border-r border-border bg-surface/95 shadow-2xl transition-transform duration-200 ease-out md:static md:z-auto md:shrink-0 md:translate-x-0 md:bg-surface/40 md:shadow-none ${
        mobileOpen ? 'visible translate-x-0' : 'invisible -translate-x-full md:visible'
      }`}
    >
      <div className="flex items-center gap-2.5 px-5 py-5 text-[15px] font-semibold tracking-tight">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-raised text-base">🐼</span>
        Panda
        <button
          type="button"
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-fg md:hidden"
          aria-label="关闭导航"
          onClick={onMobileClose}
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex items-center justify-between px-5 pb-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-faint">
          Sessions
        </span>
        <button
          onClick={() => {
            if (foregroundCwd) live.newSession(foregroundCwd);
            onMobileClose();
          }}
          disabled={!liveMode || !foregroundConnected || !foregroundCwd || foregroundBusy}
          className="flex h-5 w-5 items-center justify-center rounded text-faint transition-colors enabled:hover:bg-raised enabled:hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="新建会话"
          title={
            liveMode && foregroundConnected && foregroundCwd && !foregroundBusy
              ? '在前台连接新建会话（session/new）'
              : foregroundBusy
                ? '等待当前回合或切换完成'
                : '连接 agent 后可新建会话'
          }
        >
          <Plus size={13} />
        </button>
      </div>
      <div className="px-3">
        {!liveMode && (
          <div className="mb-1 flex items-center gap-2 rounded-lg bg-raised px-3 py-2.5 text-[13px] text-fg/90">
            <MessagesSquare size={13} className="shrink-0 text-faint" />
            <span className="truncate">重构 auth 校验</span>
          </div>
        )}
        <div className="space-y-1">
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
            <div className="px-3 py-2 text-xs text-faint">暂无连接或配置 — 在下方连接 ACP 服务</div>
          )}
        </div>
      </div>

      <div className="mt-auto">
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
        <div className="flex items-center gap-2 border-t border-border px-5 py-3.5 text-xs text-muted">
          <Bot size={14} className="shrink-0 text-accent" />
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

/** Status dot + spinner per connection status; running overlays a pulse. */
function StatusDot({ status, running }: { status: ConnectionStatus; running: boolean }) {
  if (status === 'connecting') {
    return <Loader2 size={12} className="shrink-0 animate-spin text-accent" />;
  }
  const color =
    status === 'connected'
      ? running
        ? 'bg-accent animate-pulse'
        : 'bg-accent/70'
      : status === 'error'
        ? 'bg-danger'
        : 'bg-faint';
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${color}`} />;
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
    <div className={`rounded-lg ${isActiveConnection ? 'bg-raised/40' : ''}`}>
      <div className="group relative">
        <button
          type="button"
          onClick={() => {
            live.foreground(connectionId);
            onMobileClose();
          }}
          title={slot.connection.url ?? title}
          className={`flex w-full items-center gap-1.5 rounded-lg px-3 py-2 text-left text-[13px] transition-colors ${
            isActiveConnection ? 'text-fg' : 'text-fg/70 hover:bg-raised/60 hover:text-fg/90'
          } ${connected ? '' : 'opacity-75'}`}
        >
          <StatusDot status={status} running={running} />
          <span className="truncate font-medium">{title}</span>
          {slot.connection.agentName && (
            <span className="truncate text-[11px] text-faint">{slot.connection.agentName}</span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1 pr-0.5">
            {/* 需要关注 is a *background* connection indicator (CONTEXT.md):
                the foreground slot's issues are in plain sight (permission
                card, error text in the connect panel). */}
            {attention && !isActiveConnection && (
              <span
                className="h-1.5 w-1.5 rounded-full bg-danger"
                title="需要关注：未读完成 / 权限待处理 / 连接错误"
              />
            )}
          </span>
        </button>
        <div className="absolute right-1 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 group-hover:flex">
          {(connected || status === 'connecting') && (
            <button
              type="button"
              onClick={() => live.disconnect(connectionId)}
              className="flex h-6 w-6 items-center justify-center rounded text-faint transition-colors hover:text-fg"
              aria-label="断开连接"
              title="断开（保留会话槽，可重连）"
            >
              <Unplug size={12} />
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              const label = profile?.name ?? slot.connection.url ?? connectionId;
              if (window.confirm(`移除连接「${label}」？其本地会话记录将被清除（按端点记忆的会话列表保留）。`)) {
                live.remove(connectionId);
              }
            }}
            className="flex h-6 w-6 items-center justify-center rounded text-faint transition-colors hover:text-danger"
            aria-label="移除连接"
            title="移除（断开并清除该连接的本地会话文档）"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      {ordered.length > 0 && (
        <div className="space-y-0.5 pb-1 pl-2">
          {ordered.map((entry) => {
            const foregroundSession = isForegroundSession(entry.sessionId);
            // Offline slots keep retained documents clickable (查看历史);
            // sessions never loaded locally stay inert until connected.
            const hasDoc = slot.docs[entry.sessionId] !== undefined;
            const canSwitch = connected ? slot.capabilities.loadSession && !busy : hasDoc;
            const label = entry.title ?? `${basename(entry.cwd)} · ${entry.sessionId.slice(-6)}`;
            return (
              <div key={entry.sessionId} className="group/s relative">
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
                          : connected && !slot.capabilities.loadSession
                            ? 'agent 不支持历史回放（session/load）'
                            : entry.cwd
                  }
                  className={`flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-[12.5px] ${
                    foregroundSession
                      ? 'bg-raised text-fg/90'
                      : canSwitch
                        ? 'text-fg/60 transition-colors hover:bg-raised/60 hover:text-fg/90'
                        : 'cursor-not-allowed text-fg/35'
                  }`}
                >
                  <MessagesSquare size={12} className="shrink-0 text-faint" />
                  <span className="truncate">{label}</span>
                </button>
                {slot.capabilities.delete && connected && !foregroundSession && !busy && (
                  <button
                    onClick={() => live.deleteSession(connectionId, entry.sessionId)}
                    className="absolute right-1.5 top-1/2 hidden h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-faint transition-colors hover:text-danger group-hover/s:flex"
                    aria-label="删除会话"
                    title="删除会话（session/delete）"
                  >
                    <Trash2 size={12} />
                  </button>
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
    <div className="group relative">
      <button
        type="button"
        onClick={() => {
          onPreview(profile);
          onMobileClose();
        }}
        title={`${profile.url} · ${profile.cwd}`}
        className="flex w-full items-center gap-1.5 rounded-lg px-3 py-2 text-left text-[13px] text-fg/50 transition-colors hover:bg-raised/60 hover:text-fg/80"
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full border border-faint" />
        <span className="truncate">{profile.name}</span>
      </button>
      <div className="absolute right-1 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 group-hover:flex">
        <button
          type="button"
          onClick={() => {
            live.connectProfile(profile);
            onMobileClose();
          }}
          className="flex h-6 w-6 items-center justify-center rounded text-faint transition-colors hover:text-accent"
          aria-label="连接此配置"
          title={`连接 ${profile.name}（${profile.url}）`}
        >
          <PlugZap size={12} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="flex h-6 w-6 items-center justify-center rounded text-faint transition-colors hover:text-danger"
          aria-label="删除配置"
          title="删除这条配置（不影响该端点已记忆的会话）"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}
