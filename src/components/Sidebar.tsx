import { Bot, MessagesSquare, Plus, Trash2 } from 'lucide-react';
import type {
  AgentCapabilityInfo,
  ConnectionInfo,
  SessionEntry,
  SessionMode,
} from '../store';
import { ConnectPanel } from './ConnectPanel';

const basename = (cwd: string) => cwd.split('/').filter(Boolean).at(-1) ?? cwd;

export function Sidebar({ mode, connection, capabilities, sessions, busy, onConnect, onDisconnect, onNewSession, onLoadSession, onDeleteSession, onReplayDemo }: {
  mode: SessionMode;
  connection: ConnectionInfo;
  capabilities: AgentCapabilityInfo;
  sessions: SessionEntry[];
  /** A turn in flight — switching sessions mid-turn would orphan the prompt. */
  busy: boolean;
  onConnect(url: string, cwd: string, opts?: { resume?: boolean }): void;
  onDisconnect(): void;
  onNewSession(cwd: string): void;
  onLoadSession(sessionId: string, cwd: string): void;
  onDeleteSession(sessionId: string): void;
  onReplayDemo(): void;
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
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface/40">
      <div className="flex items-center gap-2.5 px-5 py-5 text-[15px] font-semibold tracking-tight">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-raised text-base">🐼</span>
        Panda
      </div>

      <div className="flex items-center justify-between px-5 pb-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-faint">
          Sessions
        </span>
        {live && connected && connection.cwd && (
          <button
            onClick={() => onNewSession(connection.cwd!)}
            className="flex h-5 w-5 items-center justify-center rounded text-faint transition-colors hover:bg-raised hover:text-accent"
            aria-label="新建会话"
            title="新建会话（session/new）"
          >
            <Plus size={13} />
          </button>
        )}
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
              <div className="px-3 py-2 text-[12px] text-faint">暂无已知会话</div>
            )}
            {ordered.map((entry) => {
              const isActive = entry.sessionId === activeId;
              const label =
                entry.title ?? `${basename(entry.cwd)} · ${entry.sessionId.slice(-6)}`;
              return (
                <div key={entry.sessionId} className="group relative">
                  <button
                    disabled={isActive || !canSwitch}
                    onClick={() => onLoadSession(entry.sessionId, entry.cwd)}
                    title={
                      isActive
                        ? undefined
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
                  {capabilities.delete && connected && !isActive && (
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
          onDisconnect={onDisconnect}
          onReplayDemo={onReplayDemo}
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