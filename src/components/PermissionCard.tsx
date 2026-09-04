import { ShieldAlert, ShieldBan } from 'lucide-react';
import { Button } from '@astryxdesign/core/Button';
import type {
  DeniedPermissionResponse,
  PermissionOptionKind,
  PermissionRequest,
} from '../protocol/types';
import type { AttachedPermission } from '../projector/messageStream';
import './PermissionCard.css';

/**
/**
 * Inline approval card mounted below the tool call that triggered it —
 * the UI answer to "why did the agent stop?".
 */
export function PermissionCard({ request, onResolve }: {
  request: PermissionRequest;
  onResolve: (kind: PermissionOptionKind) => void;
}) {
  return (
    <div className="permission-card">
      <div className="permission-head">
        <ShieldAlert size={14} />
        Agent 请求批准
      </div>
      <p className="permission-title">{request.title}</p>
      <div className="permission-options">
        {request.options.map((option) => (
          <Button
            key={option.id}
            size="sm"
            variant={option.kind.startsWith('reject') ? 'secondary' : 'primary'}
            label={option.name}
            clickAction={() => onResolve(option.kind)}
          />
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
    <div className="permission-card permission-card--denied">
      <div className="permission-head permission-head--denied">
        <ShieldBan size={14} />
        已由策略拒绝
      </div>
      <p className="permission-title permission-title--dim">{request.title}</p>
      <p className="permission-reason">
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
