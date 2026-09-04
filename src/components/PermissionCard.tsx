import { ShieldAlert, ShieldBan } from 'lucide-react';
import type {
  DeniedPermissionResponse,
  PermissionOptionKind,
  PermissionRequest,
} from '../protocol/types';

/**
 * A permission as the message flow attaches it to a tool call (or renders it
 * as an independent card): pending waits for the user; denied settled by
 * host policy (issue #22). The wrapper objects are minted by App's memo so
 * their identities survive unrelated document churn — the memoized block
 * views depend on that.
 */
export type AttachedPermission =
  | { state: 'pending'; request: PermissionRequest }
  | { state: 'denied'; request: PermissionRequest; response: DeniedPermissionResponse };

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
      <p className="mt-2 text-xs text-fg/90">{request.title}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {request.options.map((option) => (
          <button
            key={option.id}
            onClick={() => onResolve(option.kind)}
            className={
              option.kind.startsWith('reject')
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

/**
 * Terminal record of a permission the host policy answered (issue #22): the
 * user never decided this, and the card says so — a silent denial would read
 * as the agent stalling for no reason.
 */
export function DeniedPermissionCard({ request, response }: {
  request: PermissionRequest;
  response: DeniedPermissionResponse;
}) {
  return (
    <div className="mt-1.5 rounded-xl border border-border bg-raised/40 p-3.5">
      <div className="flex items-center gap-2 text-xs font-medium text-muted">
        <ShieldBan size={14} />
        已由策略拒绝
      </div>
      <p className="mt-2 text-xs text-fg/70">{request.title}</p>
      <p className="mt-1.5 text-[11px] text-faint">
        {response.kind
          ? `已代答 ${response.kind}（非用户决定）`
          : 'agent 未提供拒绝选项，已代答 cancelled（非用户决定）'}
      </p>
    </div>
  );
}

/**
 * An attached permission in either state (issue #22): pending waits for the
 * user's answer, denied is the policy's terminal record. The one render
 * point both attachment sites (tool-call card, standalone card) share.
 */
export function AttachedPermissionCard({ permission, onResolve }: {
  permission: AttachedPermission;
  onResolve: (kind: PermissionOptionKind) => void;
}) {
  return permission.state === 'pending' ? (
    <PermissionCard request={permission.request} onResolve={onResolve} />
  ) : (
    <DeniedPermissionCard request={permission.request} response={permission.response} />
  );
}
