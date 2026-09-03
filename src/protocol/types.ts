/**
 * Protocol layer types.
 *
 * Two type families live here, and keeping them separate is the whole point
 * of this layer:
 *
 *  - `Acp*` types mirror the ACP wire format (session/update notifications,
 *    v1 shape, Phase 0 subset). They are event-shaped and only the reducer
 *    and the replay driver ever see them.
 *  - `SessionDocument` is the stable rendering model the UI consumes. It is
 *    document-shaped: turns, blocks, resolved tool-call state.
 *
 * v1/v2 protocol differences (v2's messageId upsert semantics,
 * running/idle/requires_action state machine) get absorbed by the reducer,
 * so components never need to know which wire version produced an event.
 *
 * Raw preservation: every event may carry the `SessionNotification` it was
 * normalized from (`raw`), and the document keeps raw notifications by
 * ownership — per message block, per tool call, latest-per-kind at session
 * level, plus an explicit bucket for unknown kinds. Unsupported ≠ dropped.
 */

import type { SessionNotification } from '@agentclientprotocol/sdk';

/** Re-exported so the protocol layer is the single import point for consumers. */
export type { SessionNotification };

// ---------------------------------------------------------------------------
// ACP wire types (v1 subset used by Phase 0)
// ---------------------------------------------------------------------------

export type AcpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export type AcpToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

export type AcpToolCallLocation = { path: string; line?: number };

export type AcpPlanPriority = 'high' | 'medium' | 'low';
export type AcpPlanStatus = 'pending' | 'in_progress' | 'completed';
export type AcpPlanEntry = {
  content: string;
  priority: AcpPlanPriority;
  status: AcpPlanStatus;
};

export type AcpCost = { amount: number; currency: string };

export type AcpToolCallContent =
  | { type: 'content'; content: AcpContentBlock }
  | { type: 'diff'; path: string; oldText: string | null; newText: string };

export type AcpSessionUpdate =
  | { sessionUpdate: 'user_message'; content: AcpContentBlock[]; raw?: SessionNotification }
  | {
      sessionUpdate: 'agent_message_chunk';
      /** Same messageId appends to the same message; a new one starts a new message. */
      messageId?: string;
      content: AcpContentBlock;
      raw?: SessionNotification;
    }
  | {
      sessionUpdate: 'agent_thought_chunk';
      messageId?: string;
      content: AcpContentBlock;
      raw?: SessionNotification;
    }
  | {
      sessionUpdate: 'tool_call';
      toolCallId: string;
      title: string;
      kind?: AcpToolKind;
      status?: AcpToolCallStatus;
      rawInput?: Record<string, unknown>;
      locations?: AcpToolCallLocation[];
      raw?: SessionNotification;
    }
  | {
      sessionUpdate: 'tool_call_update';
      /** Every field except toolCallId is optional; only changes are sent. */
      toolCallId: string;
      title?: string;
      status?: AcpToolCallStatus;
      content?: AcpToolCallContent[];
      locations?: AcpToolCallLocation[];
      raw?: SessionNotification;
    }
  | { sessionUpdate: 'plan'; entries: AcpPlanEntry[]; raw?: SessionNotification }
  | {
      sessionUpdate: 'usage_update';
      used: number;
      size: number;
      cost?: AcpCost;
      raw?: SessionNotification;
    }
  /**
   * A known session-level update kind Panda recognizes but does not render
   * in the message flow (modes, config, commands, compaction, …). Recorded
   * as the latest raw notification of its kind — nothing is dropped.
   */
  | { sessionUpdate: 'session_state'; kind: AcpSessionLevelKind; raw: SessionNotification }
  /**
   * An update Panda cannot interpret (unknown `sessionUpdate` kind, or a
   * chunk whose only content block is unsupported). Rendered as an
   * unsupported fallback block and kept in `unhandledNotifications`.
   */
  | { sessionUpdate: 'unsupported'; raw: SessionNotification };

/** Session-level update kinds that own a `latestNotifications` slot. */
export type AcpSessionLevelKind =
  | 'plan'
  | 'plan_update'
  | 'plan_removed'
  | 'usage_update'
  | 'available_commands_update'
  | 'current_mode_update'
  | 'config_option_update'
  | 'session_info_update'
  | 'compaction_update'
  | 'compaction_summary_chunk';

// ---------------------------------------------------------------------------
// Rendering model
// ---------------------------------------------------------------------------

export type SessionStatus = 'idle' | 'running' | 'requires_action';

export type ToolCallStatus = AcpToolCallStatus | 'cancelled';

export type ToolCallState = {
  id: string;
  title: string;
  kind: AcpToolKind;
  status: ToolCallStatus;
  rawInput?: Record<string, unknown>;
  content: AcpToolCallContent[];
  locations: AcpToolCallLocation[];
  /** Raw notifications folded into this tool call (create + updates), arrival order. */
  rawNotifications?: SessionNotification[];
};

export type Block =
  | { kind: 'user_message'; content: AcpContentBlock[]; rawNotifications?: SessionNotification[] }
  | {
      kind: 'agent_message';
      messageId: string;
      parts: AcpContentBlock[];
      rawNotifications?: SessionNotification[];
    }
  | {
      kind: 'thought';
      messageId: string;
      parts: AcpContentBlock[];
      rawNotifications?: SessionNotification[];
    }
  | { kind: 'tool_call'; call: ToolCallState }
  | { kind: 'plan'; entries: AcpPlanEntry[] }
  | { kind: 'unsupported'; notification: SessionNotification };

export type Turn = { id: string; blocks: Block[] };

export type Usage = {
  used: number;
  size: number;
  cost: AcpCost | null;
};

export type SessionDocument = {
  turns: Turn[];
  status: SessionStatus;
  usage: Usage;
  /**
   * Latest raw notification per session-level kind (plan/usage/mode/config/
   * commands/session_info/…). Bounded by the kind set — history per kind is
   * intentionally not kept.
   */
  latestNotifications: Partial<Record<AcpSessionLevelKind, SessionNotification>>;
  /**
   * Notifications whose `sessionUpdate` kind this Panda version does not
   * know (forward-compat / vendor extensions), arrival order. Each also
   * lands in the message flow as an `unsupported` block.
   */
  unhandledNotifications: SessionNotification[];
};

// ---------------------------------------------------------------------------
// Permission requests (session/request_permission, mirrored from the client
// side of the wire; the replay driver emits them during Phase 0, the live
// client during Phase 1). The four kinds are the exact ACP wire set.
// ---------------------------------------------------------------------------

export type PermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

export type PermissionOption = {
  id: string;
  name: string;
  kind: PermissionOptionKind;
};

export type PermissionRequest = {
  toolCallId: string;
  title: string;
  options: PermissionOption[];
};