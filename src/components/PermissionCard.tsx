import { ShieldAlert } from 'lucide-react';
import type { PermissionOptionKind, PermissionRequest } from '../protocol/types';

/**
 * Inline approval card mounted below the tool call that triggered it —
 * the UI answer to "why did the agent stop?".
 */
export function PermissionCard({ request, onResolve }: {
  request: PermissionRequest;
  onResolve: (kind: PermissionOptionKind) => void;
}) {
  return (
    <div className="mt-1.5 rounded-xl border border-warn/40 bg-warn/5 p-3.5">
      <div className="flex items-center gap-2 text-xs font-medium text-warn">
        <ShieldAlert size={14} />
        Agent 请求批准
      </div>
      <p className="mt-2 text-[13px] text-fg/90">{request.title}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {request.options.map((option) => (
          <button
            key={option.id}
            onClick={() => onResolve(option.kind)}
            className={
              option.kind === 'reject'
                ? 'rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:border-danger/50 hover:text-danger'
                : 'rounded-lg bg-accent/15 px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/25'
            }
          >
            {option.name}
          </button>
        ))}
      </div>
    </div>
  );
}