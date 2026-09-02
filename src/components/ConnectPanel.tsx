import { useState } from 'react';
import { Loader2, PlugZap, RotateCcw, Unplug } from 'lucide-react';
import type { ConnectionInfo, SessionMode } from '../store';
import { lastConnectionDefaults } from '../useLiveSession';

/**
 * Connection surface for the live ACP service. Panda is a pure protocol
 * client: this form only asks where the service listens and which working
 * directory the session should use — whoever started the ACP service owns
 * the agent process, Panda never spawns one.
 */
export function ConnectPanel({ connection, mode, onConnect, onDisconnect, onReplayDemo }: {
  connection: ConnectionInfo;
  mode: SessionMode;
  onConnect(url: string, cwd: string, opts?: { resume?: boolean }): void;
  onDisconnect(): void;
  onReplayDemo(): void;
}) {
  const [url, setUrl] = useState(() => lastConnectionDefaults().url);
  const [cwd, setCwd] = useState(() => lastConnectionDefaults().cwd);

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
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="ws://host:port/acp"
            spellCheck={false}
            className={`${inputClass} font-mono text-[11px]`}
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
              onClick={() => onConnect(url, cwd, { resume: true })}
              title="优先 resume 保留当前对话；agent 不支持时用 session/load 重建历史"
            >
              <RotateCcw size={12} />
              重连并恢复会话
            </button>
          )}
          <button
            className={`${primaryClass} ${canResume ? 'mt-2' : 'mt-2.5'}`}
            disabled={!url.trim() || !cwd.trim()}
            onClick={() => onConnect(url, cwd)}
          >
            <PlugZap size={12} />
            {canResume ? '新会话连接' : '连接'}
          </button>
        </>
      )}

      <button
        className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] text-faint transition-colors hover:text-muted"
        onClick={onReplayDemo}
      >
        <RotateCcw size={11} />
        {mode === 'demo' ? '重放 demo' : '回到 demo 回放'}
      </button>
    </div>
  );
}