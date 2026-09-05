import { KeyRound, LogIn } from 'lucide-react';
import { Button } from '@astryxdesign/core/Button';
import { ElicitationCard } from './ElicitationCard';
import { ElicitationUrlCard } from './ElicitationUrlCard';
import type {
  AcpAuthMethod,
  ElicitationRequest,
  ElicitationResponse,
} from '../protocol/types';
import type { AttachedElicitation } from '../projector/messageStream';
import './AuthGate.css';

/**
 * Main view while the foreground connection sits in auth_required (v1):
 * the agent rejected session/new with -32000 and offered login methods.
 * Picking one runs `authenticate`; the agent answers with a request-scoped
 * elicitation during the flow (OAuth url or key form), rendered below the
 * methods — same cards as the session flow, fed from the connection state.
 */
export function AuthGate({ methods, message, elicitation, onAuthenticate, onResolveElicitation, onOpenElicitationUrl }: {
  methods: AcpAuthMethod[];
  message: string | null;
  elicitation: ElicitationRequest | null;
  onAuthenticate(methodId: string): void;
  onResolveElicitation(id: string, response: ElicitationResponse): void;
  onOpenElicitationUrl(id: string): void;
}) {
  const attached: AttachedElicitation | null =
    elicitation !== null ? { state: 'pending', request: elicitation } : null;
  return (
    <div className="auth-gate">
      <div className="auth-gate-card">
        <span className="auth-gate-icon" aria-hidden>
          <KeyRound size={18} />
        </span>
        <h2 className="auth-gate-title">此 agent 需要登录</h2>
        {message && <p className="auth-gate-message">{message}</p>}
        <div className="auth-gate-methods">
          {methods.map((method) => (
            <Button
              key={method.id}
              variant="secondary"
              size="sm"
              label={method.name}
              icon={<LogIn size={13} />}
              tooltip={method.description ?? undefined}
              clickAction={() => onAuthenticate(method.id)}
            />
          ))}
          {methods.length === 0 && (
            <p className="auth-gate-none">agent 未提供浏览器可用的登录方式</p>
          )}
        </div>
        {attached?.request.mode === 'form' && (
          <ElicitationCard elicitation={attached} onResolve={onResolveElicitation} />
        )}
        {attached?.request.mode === 'url' && (
          <ElicitationUrlCard
            elicitation={attached}
            onOpen={onOpenElicitationUrl}
            onDecline={onResolveElicitation}
          />
        )}
      </div>
    </div>
  );
}
