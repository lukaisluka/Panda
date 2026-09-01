import type {
  AcpSessionUpdate,
  PermissionOptionKind,
  PermissionRequest,
  SessionStatus,
} from '../protocol/types';
import type { ReplayStep } from './types';

export type DriverHandlers = {
  onUpdate(update: AcpSessionUpdate): void;
  onStatus(status: SessionStatus): void;
  onPermission(request: PermissionRequest): void;
};

/**
 * Replays a scripted list of steps through the same handlers a real ACP
 * client would use. This is the Phase 0 stand-in for the protocol layer: the
 * reducer and the UI cannot tell a replay from a live agent.
 *
 * Permission steps pause the timeline until the user decides — mirroring the
 * real `session/request_permission` RPC where the agent thread blocks on the
 * client's answer.
 */
export class ReplayDriver {
  private queue: ReplayStep[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private waitingPermission: { request: PermissionRequest; onResolve: (decision: PermissionOptionKind) => ReplayStep[] } | null = null;
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
    this.waitingPermission = null;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  get isPlaying(): boolean {
    return this.queue.length > 0 || this.waitingPermission !== null;
  }

  resolvePermission(decision: PermissionOptionKind): void {
    const pending = this.waitingPermission;
    if (!pending) return;
    this.waitingPermission = null;
    const followUps = pending.onResolve(decision);
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
          this.handlers.onStatus(step.status);
          this.tick();
          break;
        case 'permission':
          this.handlers.onStatus('requires_action');
          this.waitingPermission = { request: step.request, onResolve: step.onResolve };
          this.handlers.onPermission(step.request);
          break;
      }
    }, step.afterMs);
  }
}