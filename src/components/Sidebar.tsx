import { Bot, MessagesSquare, Plus, Trash2, X } from 'lucide-react';
import type {
  AgentCapabilityInfo,
  ConnectionInfo,
  SessionEntry,
  SessionMode,
} from '../store';
import type { AgentProfile } from '../profiles';
import type { ConnectOptions } from '../useLiveSession';
import { ConnectPanel } from './ConnectPanel';

const basename = (cwd: string) => cwd.split('/').filter(Boolean).at(-1) ?? cwd;

export function Sidebar({ mode, connection, capabilities, sessions, busy, onConnect, onSelectProfile, onDisconnect, onNewSession, onLoadSession, onDeleteSession, onReplayDemo, mobileOpen, onMobileClose }: {
  mode: SessionMode;
  connection: ConnectionInfo;
  capabilities: AgentCapabilityInfo;
  sessions: SessionEntry[];
  /** A turn or a session switch in flight — mid-switch mutations would interleave with the transaction. */
  busy: boolean;
  onConnect(url: string, cwd: string, opts?: ConnectOptions): void;
  onSelectProfile(profile: AgentProfile): void;
  onDisconnect(): void;
  onNewSession(cwd: string): void;
  onLoadSession(sessionId: string, cwd: string): void;
  onDeleteSession(sessionId: string): void;
  onReplayDemo(): void;
  mobileOpen: boolean;
  onMobileClose(): void;
}) {
  const live = mode === 'live';
  const activeId = live ? connection.sessionId : null;
  const connected = connection.status === 'connected';
  const canSwitch = capabilities.loadSession && !busy;

  const ordered = [...sessions].sort((a, b) => {
    if (a.sessionId === activeId) return -1;
    if (b.sessionId === activeId) return 1;
    return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
  });

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
            onNewSession(connection.cwd!);
            onMobileClose();
          }}
          disabled={!live || !connected || !connection.cwd || busy}
          className="flex h-5 w-5 items-center justify-center rounded text-faint transition-colors enabled:hover:bg-raised enabled:hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="新建会话"
          title={
            live && connected && connection.cwd && !busy
              ? '新建会话（session/new）'
              : busy
                ? '等待当前回合或切换完成'
                : '连接 agent 后可新建会话'
          }
        >
          <Plus size={13} />
        </button>
      </div>
      <div className="px-3">
        {!live ? (
          <div className="flex items-center gap-2 rounded-lg bg-raised px-3 py-2.5 text-[13px] text-fg/90">
            <MessagesSquare size={13} className="shrink-0 text-faint" />
            <span className="truncate">重构 auth 校验</span>
          </div>
        ) : (
          <div className="space-y-0.5">
            {ordered.length === 0 && (
              <div className="px-3 py-2 text-xs text-faint">暂无已知会话</div>
            )}
            {ordered.map((entry) => {
              const isActive = entry.sessionId === activeId;
              const label =
                entry.title ?? `${basename(entry.cwd)} · ${entry.sessionId.slice(-6)}`;
              return (
                <div key={entry.sessionId} className="group relative">
                  <button
                    disabled={isActive || !canSwitch}
                    onClick={() => {
                      onLoadSession(entry.sessionId, entry.cwd);
                      onMobileClose();
                    }}
                    title={
                      isActive
                        ? undefined
                        : !canSwitch && busy
                          ? '等待当前回合或切换完成'
                          : canSwitch
                            ? entry.cwd
                            : 'agent 不支持历史回放（session/load）'
                    }
                    className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] ${
                      isActive
                        ? 'bg-raised text-fg/90'
                        : canSwitch
                          ? 'text-fg/70 transition-colors hover:bg-raised/60 hover:text-fg/90'
                          : 'cursor-not-allowed text-fg/40'
                    }`}
                  >
                    <MessagesSquare size={13} className="shrink-0 text-faint" />
                    <span className="truncate">{label}</span>
                  </button>
                  {capabilities.delete && connected && !isActive && !busy && (
                    <button
                      onClick={() => onDeleteSession(entry.sessionId)}
                      className="absolute right-1.5 top-1/2 hidden h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-faint transition-colors hover:text-danger group-hover:flex"
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

      <div className="mt-auto">
        <ConnectPanel
          connection={connection}
          mode={mode}
          onConnect={onConnect}
          onSelectProfile={onSelectProfile}
          onDisconnect={onDisconnect}
          onReplayDemo={() => {
            onReplayDemo();
            onMobileClose();
          }}
        />
        <div className="flex items-center gap-2 border-t border-border px-5 py-3.5 text-xs text-muted">
          <Bot size={14} className="shrink-0 text-accent" />
          <span className="truncate">
            {live
              ? connection.agentName
                ? `${connection.agentName} · live`
                : 'acp · live'
              : 'claude-code · replay'}
          </span>
        </div>
      </div>
    </aside>
  );
}
