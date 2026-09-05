import type {
  AcpSessionUpdate,
  ElicitationRequest,
  ElicitationResponse,
  PermissionOptionKind,
  PermissionRequest,
} from '../protocol/types';
import type { ReplayStep } from './types';

export type DriverHandlers = {
  onUpdate(update: AcpSessionUpdate): void;
};

/**
 * Replays a scripted list of steps through the same handlers a real ACP
 * client would use. This is the Phase 0 stand-in for the protocol layer: the
 * reducer and the UI cannot tell a replay from a live agent.
 *
 * Permission and elicitation steps pause the timeline until the user
 * decides — mirroring the real `session/request_permission` /
 * `elicitation/create` RPCs where the agent thread blocks on the client's
 * answer. The request and its resolution flow into the document as
 * `permission_requested` / `permission_resolved` and
 * `elicitation_requested` / `elicitation_resolved` events (issues #18),
 * exactly like the live client's translation of the RPCs. Url-mode
 * elicitations replay the same split the wire has: consent ends the RPC
 * (`elicitation_url_opened`), the agent's `elicitation/complete`
 * notification lands later as its own step.
 */
export class ReplayDriver {
  private queue: ReplayStep[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private waitingPermission: { request: PermissionRequest; onResolve: (decision: PermissionOptionKind) => ReplayStep[] } | null = null;
  private waitingElicitation:
    | { kind: 'form'; request: ElicitationRequest; onResolve: (response: ElicitationResponse) => ReplayStep[] }
    | { kind: 'url'; request: ElicitationRequest; onResolve: (response: ElicitationResponse) => ReplayStep[]; onOpen: () => ReplayStep[] }
    | null = null;
  private stopped = false;

  constructor(private readonly handlers: DriverHandlers) {}

  play(steps: ReplayStep[]): void {
    this.stopped = false;
    this.queue = [...steps];
    this.tick();
  }

  cancel(): void {
    this.stopped = true;
    this.queue = [];
    if (this.waitingPermission) {
      this.handlers.onUpdate({
        sessionUpdate: 'permission_resolved',
        toolCallId: this.waitingPermission.request.toolCallId,
        response: { outcome: 'cancelled' },
      });
    }
    this.waitingPermission = null;
    if (this.waitingElicitation) {
      this.handlers.onUpdate({
        sessionUpdate: 'elicitation_resolved',
        elicitationId: this.waitingElicitation.request.id,
        response: { outcome: 'cancelled' },
      });
    }
    this.waitingElicitation = null;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  get isPlaying(): boolean {
    return this.queue.length > 0 || this.waitingPermission !== null || this.waitingElicitation !== null;
  }

  resolvePermission(decision: PermissionOptionKind): void {
    const pending = this.waitingPermission;
    if (!pending) return;
    this.waitingPermission = null;
    this.handlers.onUpdate({
      sessionUpdate: 'permission_resolved',
      toolCallId: pending.request.toolCallId,
      response: { outcome: 'selected', kind: decision },
    });
    const followUps = pending.onResolve(decision);
    this.queue = [...followUps, ...this.queue];
    this.tick();
  }

  resolveElicitation(response: ElicitationResponse): void {
    const pending = this.waitingElicitation;
    if (!pending) return;
    this.waitingElicitation = null;
    this.handlers.onUpdate({
      sessionUpdate: 'elicitation_resolved',
      elicitationId: pending.request.id,
      response,
    });
    const followUps = pending.onResolve(response);
    this.queue = [...followUps, ...this.queue];
    this.tick();
  }

  /** The url-mode consent: answer accept, keep playing (completion arrives as its own step). */
  openElicitationUrl(): void {
    const pending = this.waitingElicitation;
    if (!pending || pending.kind !== 'url') return;
    this.waitingElicitation = null;
    this.handlers.onUpdate({
      sessionUpdate: 'elicitation_url_opened',
      elicitationId: pending.request.id,
    });
    const followUps = pending.onOpen();
    this.queue = [...followUps, ...this.queue];
    this.tick();
  }

  private tick(): void {
    if (this.stopped) return;
    const step = this.queue.shift();
    if (!step) return;

    this.timer = setTimeout(() => {
      this.timer = null;
      switch (step.kind) {
        case 'update':
          this.handlers.onUpdate(step.update);
          this.tick();
          break;
        case 'status':
          this.handlers.onUpdate({ sessionUpdate: 'status_changed', status: step.status });
          this.tick();
          break;
        case 'permission':
          this.handlers.onUpdate({ sessionUpdate: 'status_changed', status: 'requires_action' });
          this.waitingPermission = { request: step.request, onResolve: step.onResolve };
          this.handlers.onUpdate({
            sessionUpdate: 'permission_requested',
            request: step.request,
          });
          break;
        case 'elicitation':
          this.handlers.onUpdate({ sessionUpdate: 'status_changed', status: 'requires_action' });
          this.waitingElicitation = { kind: 'form', request: step.request, onResolve: step.onResolve };
          this.handlers.onUpdate({
            sessionUpdate: 'elicitation_requested',
            request: step.request,
          });
          break;
        case 'elicitation_url':
          this.handlers.onUpdate({ sessionUpdate: 'status_changed', status: 'requires_action' });
          this.waitingElicitation = { kind: 'url', request: step.request, onResolve: step.onResolve, onOpen: step.onOpen };
          this.handlers.onUpdate({
            sessionUpdate: 'elicitation_requested',
            request: step.request,
          });
          break;
        case 'elicitation_url_complete':
          this.handlers.onUpdate({
            sessionUpdate: 'elicitation_url_completed',
            elicitationId: step.elicitationId,
          });
          this.tick();
          break;
      }
    }, step.afterMs);
  }
}
