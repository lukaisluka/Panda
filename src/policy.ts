/**
 * Host-side permission policy (issue #22, ADR 0004).
 *
 * Every `session/request_permission` consults the active policy before it
 * hangs for the user. The verdict union deliberately has NO `allow` member:
 * auto-approval is not expressible, only ask-able. A policy that wants to
 * deny answers on the user's behalf with a reject option — never an allow.
 */

import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { PermissionOptionKind, PermissionResponse } from './protocol/types';

/**
 * The policy verdict. `ask` = the user decides (the current UI flow);
 * `deny` = the host rejects on the user's behalf. There is no `allow`
 * (ADR 0004) — approving is the user's move, always.
 */
export type PermissionDecision = 'ask' | 'deny';

/** What a policy knows about the connection a permission arrived on. */
export type PermissionPolicyContext = {
  /** The connection's id (Agent 配置 id, or a 临时直连 id). */
  connectionId: string;
  /** The endpoint the connection is talking to, if known. */
  url: string | null;
};

/** A programmable synchronous decision function (issue #22 spec). */
export type PermissionPolicy = (
  request: RequestPermissionRequest,
  context: PermissionPolicyContext,
) => PermissionDecision;

/** The default policy: every permission is the user's to decide. */
export const alwaysAskPolicy: PermissionPolicy = () => 'ask';

/**
 * Resolves a policy `deny` against the agent's offered options:
 * `reject_once` first, then `reject_always`; an agent offering neither
 * (malformed or hostile) is answered `cancelled` — a deny never selects an
 * allow option. Returns the wire outcome plus the document-facing response:
 * `denied-by-policy` carrying the reject kind used, or null when cancelled.
 */
export function denyResolution(
  options: ReadonlyArray<{ optionId: string; kind: PermissionOptionKind }>,
): { wire: RequestPermissionResponse; ui: Extract<PermissionResponse, { outcome: 'denied-by-policy' }> } {
  const option =
    options.find((candidate) => candidate.kind === 'reject_once') ??
    options.find((candidate) => candidate.kind === 'reject_always') ??
    null;
  if (!option) {
    return {
      wire: { outcome: { outcome: 'cancelled' } },
      ui: { outcome: 'denied-by-policy', kind: null },
    };
  }
  return {
    wire: { outcome: { outcome: 'selected', optionId: option.optionId } },
    ui: { outcome: 'denied-by-policy', kind: option.kind },
  };
}
