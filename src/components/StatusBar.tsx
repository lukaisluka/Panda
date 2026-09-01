import { CircleDot, Loader2, ShieldAlert } from 'lucide-react';
import type { SessionDocument } from '../protocol/types';

const formatTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Session state on the left, context-usage meter and cost on the right. */
export function StatusBar({ doc }: { doc: SessionDocument }) {
  const { status, usage } = doc;
  const pct = usage.size > 0 ? Math.min(100, (usage.used / usage.size) * 100) : 0;

  return (
    <div className="flex items-center justify-between border-t border-border px-6 py-2 text-xs">
      <div className="flex items-center gap-2">
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
      </div>

      {usage.size > 0 && (
        <div className="flex items-center gap-3 text-faint">
          <div className="h-1 w-36 overflow-hidden rounded-full bg-raised">
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