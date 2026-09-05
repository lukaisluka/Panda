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
import { useI18n } from '../i18n/context';

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
  const { t } = useI18n();
  return (
    <div className="permission-card">
      <div className="permission-head">
        <ShieldAlert size={14} />
        {t('perm.title')}
      </div>
      <p className="permission-title">{request.title}</p>
      <div className="permission-options">
        {request.options.map((option) => (
          <Button
            key={option.id}
            size="sm"
            variant={option.kind.startsWith('reject') ? 'secondary' : 'primary'}
            label={ANSWERABLE_KINDS.has(option.kind) ? option.name : t('perm.unknownOption', { name: option.name })}
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
  const { t } = useI18n();
  return (
    <div className="permission-card permission-card--denied">
      <div className="permission-head permission-head--denied">
        <ShieldBan size={14} />
        {t('perm.deniedByPolicy')}
      </div>
      <p className="permission-title permission-title--dim">{request.title}</p>
      <p className="permission-reason">
        {response.kind
          ? t('perm.autoAnswered', { kind: response.kind })
          : t('perm.autoCancelled')}
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
  const { t } = useI18n();
  return (
    <div className="permission-card permission-card--remembered">
      <div className="permission-head permission-head--remembered">
        {response.kind === 'reject_always' ? <ShieldBan size={14} /> : <ShieldCheck size={14} />}
        {t('perm.byPriorChoice')}
      </div>
      <p className="permission-title permission-title--dim">{request.title}</p>
      <p className="permission-reason">
        {response.kind === 'reject_always'
          ? t('perm.autoRejected')
          : t('perm.autoAllowed')}
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
  const { t } = useI18n();
  const KIND_LABEL: Record<string, 'perm.allowOnce' | 'perm.allowAlways' | 'perm.rejectOnce' | 'perm.rejectAlways'> = {
    allow_once: 'perm.allowOnce',
    allow_always: 'perm.allowAlways',
    reject_once: 'perm.rejectOnce',
    reject_always: 'perm.rejectAlways',
  };
  return (
    <div className="permission-card permission-card--resolved">
      <div className="permission-head permission-head--resolved">
        {allowed ? <ShieldCheck size={14} /> : <ShieldBan size={14} />}
        {allowed ? t('perm.approved') : t('perm.rejected')} · {KIND_LABEL[response.kind] ? t(KIND_LABEL[response.kind]!) : String(response.kind)}
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
