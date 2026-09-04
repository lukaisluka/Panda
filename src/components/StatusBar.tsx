import { CircleDot, ShieldAlert } from 'lucide-react';
import { Spinner } from '@astryxdesign/core/Spinner';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import type { SessionDocument } from '../protocol/types';
import type { ConnectionInfo, SessionMode } from '../store';
import { ContentColumn } from './ContentColumn';

const formatTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Session state + live connection on the left, context-usage meter and cost on the right. */
export function StatusBar({ doc, connection, mode, switching }: {
  doc: SessionDocument;
  connection: ConnectionInfo;
  mode: SessionMode;
  /** A transactional session switch is in flight (issue #17). */
  switching: boolean;
}) {
  const { status, usage } = doc;
  const pct = usage.size > 0 ? Math.min(100, (usage.used / usage.size) * 100) : 0;

  return (
    <div className="border-t border-border py-2 text-xs">
      <ContentColumn className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          {mode === 'live' && (
            <span className="flex items-center gap-1.5">
              {connection.status === 'connected' ? (
                switching ? (
                  <>
                    <Spinner size="sm" />
                    <span className="text-faint">切换会话中…</span>
                  </>
                ) : connection.error ? (
                  // A failed switch (or similar non-fatal failure) leaves the
                  // connection up with a reason to show (issue #17).
                  <span className="max-w-72 truncate text-danger" title={connection.error}>
                    {connection.error}
                  </span>
                ) : (
                  <>
                    <StatusDot variant="success" label="已连接" />
                    <span className="max-w-40 truncate text-faint" title={connection.url ?? undefined}>
                      {connection.agentName}
                    </span>
                  </>
                )
              ) : connection.status === 'connecting' ? (
                <>
                  <Spinner size="sm" />
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
                <Spinner size="sm" />
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
            <span className="font-mono text-xs">
              {formatTokens(usage.used)} / {formatTokens(usage.size)} tokens
            </span>
            {usage.cost && (
              <span className="font-mono text-xs">${usage.cost.amount.toFixed(2)}</span>
            )}
          </div>
        )}
      </ContentColumn>
    </div>
  );
}