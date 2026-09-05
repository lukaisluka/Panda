import { ShieldAlert, ShieldBan, ShieldCheck } from 'lucide-react';
import { Button } from '@astryxdesign/core/Button';
import type {
  DeniedPermissionResponse,
  PermissionOptionKind,
  PermissionRequest,
  RememberedPermissionResponse,
  SelectedPermissionResponse,
} from '../protocol/types';
import type { AttachedPermission } from '../projector/messageStream';
import './PermissionCard.css';

/** The option kinds Panda can actually answer; the wire stays open (the
 * parse layer is deliberately unvalidated), so anything else renders
 * disabled instead of answering a kind the client cannot map (issue #79). */
const ANSWERABLE_KINDS = new Set<string>(['allow_once', 'allow_always', 'reject_once', 'reject_always']);

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
            label={ANSWERABLE_KINDS.has(option.kind) ? option.name : `${option.name}(未知选项类型)`}
            isDisabled={!ANSWERABLE_KINDS.has(option.kind)}
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
 * Terminal record of a permission the session memory answered (issue #68):
 * the user chose this 'always' option for the same action earlier in the
 * session, so the answer is theirs — replayed, not invented. The card says
 * so; an unexplained auto-approval would read as the agent approving itself.
 */
export function RememberedPermissionCard({ request, response }: {
  request: PermissionRequest;
  response: RememberedPermissionResponse;
}) {
  return (
    <div className="permission-card permission-card--remembered">
      <div className="permission-head permission-head--remembered">
        {response.kind === 'reject_always' ? <ShieldBan size={14} /> : <ShieldCheck size={14} />}
        按本会话既往选择代答
      </div>
      <p className="permission-title permission-title--dim">{request.title}</p>
      <p className="permission-reason">
        {response.kind === 'reject_always'
          ? '你本会话曾对同一操作选择 reject_always，已自动拒绝'
          : '你本会话曾对同一操作选择 allow_always，已自动放行'}
      </p>
    </div>
  );
}

/**
 * Settled record of a permission the user answered by hand (issue #79): the
 * transcript's only trace of what was approved/rejected — kept as one
 * compact line so history stays readable, mirroring the denied/remembered
 * records rather than vanishing on click.
 */
export function ResolvedPermissionCard({ request, response }: {
  request: PermissionRequest;
  response: SelectedPermissionResponse;
}) {
  const allowed = response.kind.startsWith('allow');
  const KIND_LABEL: Record<string, string> = {
    allow_once: '允许',
    allow_always: '始终允许',
    reject_once: '拒绝',
    reject_always: '始终拒绝',
  };
  return (
    <div className="permission-card permission-card--resolved">
      <div className="permission-head permission-head--resolved">
        {allowed ? <ShieldCheck size={14} /> : <ShieldBan size={14} />}
        {allowed ? '已批准' : '已拒绝'} · {KIND_LABEL[response.kind] ?? String(response.kind)}
      </div>
      <p className="permission-title permission-title--dim">{request.title}</p>
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
  if (permission.state === 'pending') {
    return <PermissionCard request={permission.request} onResolve={onResolve} />;
  }
  if (permission.state === 'remembered') {
    return <RememberedPermissionCard request={permission.request} response={permission.response} />;
  }
  if (permission.state === 'resolved') {
    return <ResolvedPermissionCard request={permission.request} response={permission.response} />;
  }
  return <DeniedPermissionCard request={permission.request} response={permission.response} />;
}
