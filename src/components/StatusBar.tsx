import { CircleDot, ShieldAlert } from 'lucide-react';
import { Spinner } from '@astryxdesign/core/Spinner';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import type { SessionDocument } from '../protocol/types';
import type { ConnectionInfo, SessionMode } from '../store';
import { useForegroundLifecycle } from '../projector/hooks';
import { ContentColumn } from './ContentColumn';
import './StatusBar.css';

const formatTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Session state + live connection on the left, context-usage meter and cost
 * on the right. Status meaning comes from the lifecycle projection (#53):
 * this component only maps a ConnectionPhase to pixels. */
export function StatusBar({ doc, connection, mode }: {
  doc: SessionDocument;
  /** Display facts (agentName, url) — the status interpretation lives in
   * the lifecycle projection, consumed below. */
  connection: ConnectionInfo;
  mode: SessionMode;
}) {
  const lifecycle = useForegroundLifecycle();
  const usage = doc.usage;
  const pct = usage.size > 0 ? Math.min(100, (usage.used / usage.size) * 100) : 0;

  return (
    <div className="statusbar">
      <ContentColumn className="statusbar-inner">
        <div className="statusbar-cluster">
          {mode === 'live' && (
            <span className="statusbar-conn">
              {lifecycle.phase === 'connecting' ? (
                <>
                  <Spinner size="sm" />
                  <span className="statusbar-faint">连接中…</span>
                </>
              ) : lifecycle.phase === 'error' ? (
                <span className="truncate statusbar-error" title={lifecycle.error ?? undefined}>
                  {lifecycle.error}
                </span>
              ) : lifecycle.phase === 'auth-required' ? (
                <span className="truncate statusbar-warn-text" title={lifecycle.error ?? undefined}>
                  需要登录
                </span>
              ) : lifecycle.phase === 'disconnected' ? (
                <span className="statusbar-faint">未连接</span>
              ) : lifecycle.phase === 'switching-session' ? (
                <>
                  <Spinner size="sm" />
                  <span className="statusbar-faint">切换会话中…</span>
                </>
              ) : lifecycle.phase === 'connected-degraded' ? (
                // A failed switch (or similar non-fatal failure) leaves the
                // connection up with a reason to show (issue #17).
                <span className="truncate statusbar-error" title={lifecycle.error ?? undefined}>
                  {lifecycle.error}
                </span>
              ) : (
                <>
                  <StatusDot variant="success" label="已连接" />
                  <span className="truncate statusbar-agent" title={connection.url ?? undefined}>
                    {connection.agentName}
                  </span>
                </>
              )}
            </span>
          )}

          <span className="statusbar-session">
            {lifecycle.docStatus === 'running' ? (
              <>
                <Spinner size="sm" />
                <span className="statusbar-muted">Working…</span>
              </>
            ) : lifecycle.docStatus === 'requires_action' ? (
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
