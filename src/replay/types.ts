import type {
  AcpSessionUpdate,
  ElicitationRequest,
  ElicitationResponse,
  PermissionOptionKind,
  PermissionRequest,
  SessionStatus,
} from '../protocol/types';

/** Steps the replay driver executes against the session document. */
export type ReplayStep =
  | { kind: 'update'; afterMs: number; update: AcpSessionUpdate }
  | { kind: 'status'; afterMs: number; status: SessionStatus }
  | {
      kind: 'permission';
      afterMs: number;
      request: PermissionRequest;
      /** Branches the timeline into allow/reject follow-ups on decision. */
      onResolve: (decision: PermissionOptionKind) => ReplayStep[];
    }
  | {
      kind: 'elicitation';
      afterMs: number;
      request: ElicitationRequest;
      /** Branches the timeline on the user's answer (accepted / declined). */
      onResolve: (response: ElicitationResponse) => ReplayStep[];
    };
