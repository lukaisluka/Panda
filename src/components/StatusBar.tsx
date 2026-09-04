import { CircleDot, ShieldAlert } from 'lucide-react';
import { Spinner } from '@astryxdesign/core/Spinner';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import type { SessionDocument } from '../protocol/types';
import type { ConnectionInfo, SessionMode } from '../store';
import { ContentColumn } from './ContentColumn';
import './StatusBar.css';

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
    <div className="statusbar">
      <ContentColumn className="statusbar-inner">
        <div className="statusbar-cluster">
          {mode === 'live' && (
            <span className="statusbar-conn">
              {connection.status === 'connected' ? (
                switching ? (
                  <>
                    <Spinner size="sm" />
                    <span className="statusbar-faint">切换会话中…</span>
                  </>
                ) : connection.error ? (
                  // A failed switch (or similar non-fatal failure) leaves the
                  // connection up with a reason to show (issue #17).
                  <span className="truncate statusbar-error" title={connection.error}>
                    {connection.error}
                  </span>
                ) : (
                  <>
                    <StatusDot variant="success" label="已连接" />
                    <span className="truncate statusbar-agent" title={connection.url ?? undefined}>
                      {connection.agentName}
                    </span>
                  </>
                )
              ) : connection.status === 'connecting' ? (
                <>
                  <Spinner size="sm" />
                  <span className="statusbar-faint">连接中…</span>
                </>
              ) : connection.status === 'error' ? (
                <span className="truncate statusbar-error" title={connection.error ?? undefined}>
                  {connection.error}
                </span>
              ) : (
                <span className="statusbar-faint">未连接</span>
              )}
            </span>
          )}

          <span className="statusbar-session">
            {status === 'running' ? (
              <>
                <Spinner size="sm" />
                <span className="statusbar-muted">Working…</span>
              </>
            ) : status === 'requires_action' ? (
              <>
                <ShieldAlert size={13} className="statusbar-warn-icon" />
                <span className="statusbar-warn-text">等待你的批准</span>
              </>
            ) : (
              <>
                <CircleDot size={13} className="statusbar-accent-icon" />
                <span className="statusbar-faint">Ready</span>
              </>
            )}
          </span>
        </div>

        {usage.size > 0 && (
          <div className="statusbar-usage">
            <div className="statusbar-meter">
              <div
                className="statusbar-meter-fill"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="statusbar-mono">
              {formatTokens(usage.used)} / {formatTokens(usage.size)} tokens
            </span>
            {usage.cost && (
              <span className="statusbar-mono">${usage.cost.amount.toFixed(2)}</span>
            )}
          </div>
        )}
      </ContentColumn>
    </div>
  );
}
