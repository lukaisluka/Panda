import { CircleDot, Loader2, ShieldAlert } from 'lucide-react';
import type { SessionDocument } from '../protocol/types';
import type { ConnectionInfo, SessionMode } from '../store';

const formatTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Session state + live connection on the left, context-usage meter and cost on the right. */
export function StatusBar({ doc, connection, mode }: {
  doc: SessionDocument;
  connection: ConnectionInfo;
  mode: SessionMode;
}) {
  const { status, usage } = doc;
  const pct = usage.size > 0 ? Math.min(100, (usage.used / usage.size) * 100) : 0;

  return (
    <div className="flex flex-col gap-1.5 border-t border-border px-3 py-2 text-xs sm:flex-row sm:items-center sm:justify-between sm:px-6">
      <div className="flex items-center gap-3">
        {mode === 'live' && (
          <span className="flex items-center gap-1.5">
            {connection.status === 'connected' ? (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                <span className="max-w-40 truncate text-faint" title={connection.url ?? undefined}>
                  {connection.agentName}
                </span>
              </>
            ) : connection.status === 'connecting' ? (
              <>
                <Loader2 size={12} className="animate-spin text-accent" />
                <span className="text-faint">连接中…</span>
              </>
            ) : connection.status === 'error' ? (
              <span className="max-w-72 truncate text-danger" title={connection.error ?? undefined}>
                {connection.error}
              </span>
            ) : (
              <span className="text-faint">未连接</span>
            )}
          </span>
        )}

        <span className="flex items-center gap-2">
          {status === 'running' ? (
            <>
              <Loader2 size={13} className="animate-spin text-accent" />
              <span className="text-muted">Working…</span>
            </>
          ) : status === 'requires_action' ? (
            <>
              <ShieldAlert size={13} className="text-warn" />
              <span className="font-medium text-warn">等待你的批准</span>
            </>
          ) : (
            <>
              <CircleDot size={13} className="text-accent" />
              <span className="text-faint">Ready</span>
            </>
          )}
        </span>
      </div>

      {usage.size > 0 && (
        <div className="flex items-center gap-2 self-end whitespace-nowrap text-faint sm:gap-3">
          <div className="hidden h-1 w-36 overflow-hidden rounded-full bg-raised sm:block">
            <div
              className="h-full rounded-full bg-accent/70 transition-[width] duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="font-mono text-[11px]">
            {formatTokens(usage.used)} / {formatTokens(usage.size)} tokens
          </span>
          {usage.cost && (
            <span className="font-mono text-[11px]">${usage.cost.amount.toFixed(2)}</span>
          )}
        </div>
      )}
    </div>
  );
}
