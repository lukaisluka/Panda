/**
 * Protocol layer types.
 *
 * Two type families live here, and keeping them separate is the whole point
 * of this layer:
 *
 *  - `Acp*` types mirror the ACP wire format (session/update notifications,
 *    v1 shape, Phase 0 subset). They are event-shaped and only the reducer
 *    and the replay driver ever see them.
 *  - `SessionDocument` is the session's domain state: the accumulated
 *    protocol facts, document-shaped (turns, blocks, resolved tool-call
 *    state). Render models are never stored here — they are derived from
 *    the document by the projector layer (issue #24, ADR 0006).
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

/** v1 PromptResponse.stopReason — why a prompt turn ended. */
export type AcpStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

/**
 * v1 CompactionStatus — the lifecycle of a context compaction. The wire type
 * allows unknown strings (forward-compat); unknown ones render like
 * in_progress until a terminal status lands.
 */
export type AcpCompactionStatus = 'in_progress' | 'completed' | 'failed' | 'cancelled' | (string & {});

// -- auth (protocol/v1 authentication) ------------------------------------------

/**
 * v1 InitializeResponse.authMethods, whitelisted to the agent-managed
 * variant (`authenticate`-able). The terminal variant is filtered in the
 * client: a web client cannot reproduce the agent's TUI login and does not
 * advertise the terminal auth capability, so a compliant agent never sends it.
 */
export type AcpAuthMethod = { id: string; name: string; description?: string };

// -- elicitation (protocol/v1 elicitation, form mode) --------------------------

/** A titled choice for enum-like fields. */
export type AcpElicitationOption = { value: string; label: string };

/**
 * One form field, whitelisted from the wire's restricted ElicitationSchema
 * (primitive types only — that restriction is why no JSON-Schema form
 * library is needed). `unsupported` covers future/vendor property types:
 * rendered as an inert, visible row, never silently dropped.
 */
export type AcpElicitationField =
  | {
      key: string;
      type: 'string';
      title: string;
      description?: string;
      required: boolean;
      /** null = free text; a list = single-select. */
      options: AcpElicitationOption[] | null;
      default?: string;
    }
  | {
      key: string;
      type: 'number' | 'integer';
      title: string;
      description?: string;
      required: boolean;
      default?: number;
    }
  | {
      key: string;
      type: 'boolean';
      title: string;
      description?: string;
      required: boolean;
      default?: boolean;
    }
  | {
      key: string;
      type: 'multiselect';
      title: string;
      description?: string;
      required: boolean;
      options: AcpElicitationOption[];
      default?: string[];
    }
  | { key: string; type: 'unsupported'; title: string; required: false; propertyType: string };

/**
 * The UI card model for a `elicitation/create` request, discriminated by
 * mode. The form id is Panda-local (minted per RPC — form-mode requests
 * carry no wire id); the url id IS the wire `elicitationId`, because the
 * later `elicitation/complete` notification matches on it.
 */
export type ElicitationRequest =
  | {
      mode: 'form';
      id: string;
      /** The scope's optional tool call, shown as context on the card. */
      toolCallId: string | null;
      title: string | null;
      description: string | null;
      fields: AcpElicitationField[];
    }
  | {
      mode: 'url';
      id: string;
      toolCallId: string | null;
      /** The wire `message` — what the agent wants the user to authorize. */
      message: string | null;
      url: string;
    };

/**
 * How an elicitation settled. `accepted.content` conforms to the requested
 * schema (values are the schema's primitives; multiselects are string
 * arrays). `declined` is the user refusing; `cancelled` is no user decision
 * at all (turn cancel, disconnect, agent abort).
 */
export type ElicitationResponse =
  | { outcome: 'accepted'; content: Record<string, string | number | boolean | string[]> }
  | { outcome: 'declined' }
  | { outcome: 'cancelled' };

/**
 * `pending` is awaiting the user (form: submit/decline; url: open/decline).
 * `opened` is url-only: the user consented and the link is open, but the
 * out-of-band interaction is still running — the RPC already answered
 * accept, the card now waits for `elicitation/complete`. `completed` is the
 * url terminal state that notification drives. `resolved`/`cancelled` come
 * from `elicitation_resolved` (form settle, url decline, any cancel).
 */
export type ElicitationState = {
  status: 'pending' | 'opened' | 'resolved' | 'completed' | 'cancelled';
  request: ElicitationRequest;
  response: ElicitationResponse | null;
};

// -- session modes (protocol/v1 session-modes) --------------------------------

export type AcpSessionMode = {
  id: string;
  name: string;
  description?: string;
};

/**
 * The agent's operating-mode state, mirrored from `session/new` /
 * `session/load` results (and switchable via `session/set_mode`). `null` in
 * the document means the agent did not advertise modes — the mode picker
 * hides entirely rather than rendering an empty control.
 */
export type AcpSessionModeState = {
  currentModeId: string;
  availableModes: AcpSessionMode[];
};

/**
 * A slash command the agent advertised via `available_commands_update`.
 * Whitelisted from the wire `AvailableCommand`: `input` collapses to its
 * `hint` string (the only v1 input shape — an unstructured text argument),
 * null when the command takes no input. Executing a command is just sending
 * `/name 参数` as a normal prompt; the agent recognizes the prefix itself.
 */
export type AcpAvailableCommand = {
  name: string;
  description: string;
  inputHint: string | null;
};

/**
 * One selectable value of a config `select` option. Wire options come flat
 * or grouped (`SessionConfigSelectOptions`); grouping is flattened into
 * `group` labels here — the UI rebuilds `<optgroup>`s from them. `group` is
 * the group's display name (its wire id is routing metadata Panda never
 * needs: writes address values, not groups).
 */
export type AcpConfigChoice = {
  value: string;
  name: string;
  description: string | null;
  group: string | null;
};

/**
 * A session config option advertised by the agent (wire `SessionConfigOption`)
 * — whitelisted into the two control shapes the UI renders: `select` (single
 * dropdown) and `boolean` (toggle). `currentValue` is the agent's truth;
 * writes go through `session/set_config_option`, whose response carries the
 * full updated list (confirmation-driven, same pattern as set_mode).
 */
export type AcpConfigOption =
  | {
      type: 'select';
      id: string;
      name: string;
      description: string | null;
      category: string | null;
      currentValue: string;
      choices: AcpConfigChoice[];
    }
  | {
      type: 'boolean';
      id: string;
      name: string;
      description: string | null;
      category: string | null;
      currentValue: boolean;
    };

export type AcpToolCallContent =
  | { type: 'content'; content: AcpContentBlock }
  | { type: 'diff'; path: string; oldText: string | null; newText: string }
  /** Explicit fallback row for protocol content Panda cannot render
   * (audio/resource/resource_link blocks, terminal tool content): the wire
   * mapper emits these instead of dropping the block, so the stream shows
   * "there is something here" rather than silently losing it. */
  | { type: 'unsupported'; blockType: string };

export type AcpSessionUpdate =
  | {
      sessionUpdate: 'user_message';
      content: AcpContentBlock[];
      /**
       * Local optimistic echo from `send()`, not a protocol event. Echo
       * reconciliation replaces it with `user_message_confirmed` when the
       * agent's echo matches; it is never forged into a protocol notification.
       */
      optimistic?: true;
      raw?: SessionNotification;
    }
  | {
      /**
       * The live driver reconciled the agent's echo of the pending outbound
       * message (issue #15). Equal echo: the trailing optimistic user block
       * keeps its rendered content, gains the protocol-side messageId and the
       * buffered echo notifications as attribution, and stops being merely
       * optimistic.
       */
      sessionUpdate: 'user_message_confirmed';
      protocolMessageId?: string;
      notifications: SessionNotification[];
    }
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
      /** v1 ToolCallUpdate.kind — agents may classify the call only after
       * creation; a late kind re-icons the existing card. */
      kind?: AcpToolKind;
      status?: AcpToolCallStatus;
      content?: AcpToolCallContent[];
      locations?: AcpToolCallLocation[];
      /** v1 ToolCallUpdate.rawInput — same merge rule as the create event. */
      rawInput?: Record<string, unknown>;
      /** The tool's raw output object, when the agent reports it separately
       * from content (protocol v1 ToolCallUpdate.rawOutput). */
      rawOutput?: Record<string, unknown>;
      raw?: SessionNotification;
    }
  | {
      sessionUpdate: 'plan';
      entries: AcpPlanEntry[];
      raw?: SessionNotification;
    }
  /**
   * The agent withdrew the plan (wire `plan_removed`). Docked UI clears the
   * plan panel; the raw notification is still recorded under its kind.
   */
  | { sessionUpdate: 'plan_removed'; raw?: SessionNotification }
  /**
   * A context compaction changed state (wire `compaction_update`). Wire patch
   * semantics travel verbatim — omitted summary/error keeps the stored value,
   * null clears, a value replaces — and the reducer folds per compactionId.
   */
  | {
      sessionUpdate: 'compaction_update';
      compactionId: string;
      status: AcpCompactionStatus;
      summary?: AcpContentBlock[] | null;
      error?: string | null;
      raw?: SessionNotification;
    }
  /**
   * One content block appended to an in-progress compaction's summary (wire
   * `compaction_summary_chunk`). No rendering of its own — it only feeds the
   * stored summary the completed notice will be able to show.
   */
  | { sessionUpdate: 'compaction_summary_chunk'; compactionId: string; content: AcpContentBlock; raw?: SessionNotification }
  | {
      sessionUpdate: 'usage_update';
      used: number;
      size: number;
      cost?: AcpCost;
      raw?: SessionNotification;
    }
  /**
   * A prompt turn ended with a stop reason other than end_turn — the live
   * driver translates the PromptResponse (not a wire notification, same
   * pattern as modes_initialized). Rendered as a system row in the flow:
   * refusal / max_tokens / max_turn_requests / cancelled must be visible,
   * not silent.
   */
  | { sessionUpdate: 'turn_notice'; stopReason: Exclude<AcpStopReason, 'end_turn'> }
  /**
   * The session's mode state arrived (session/new or session/load result).
   * Not a wire notification — the drivers translate the RPC result into this
   * event, exactly like the permission lifecycle events below. null = the
   * agent supports no modes; a later result replaces the whole state.
   */
  | { sessionUpdate: 'modes_initialized'; modes: AcpSessionModeState | null }
  /**
   * The current mode changed: either confirmed by a successful
   * `session/set_mode` RPC (deepagents-acp never emits the notification, so
   * the RPC result must drive the update) or observed as a
   * `current_mode_update` notification (agent-side switch, e.g. an approved
   * switch_mode tool call). Idempotent — both sources land on this event.
   */
  | { sessionUpdate: 'mode_changed'; modeId: string; raw?: SessionNotification }
  /**
   * The agent's slash-command list arrived or changed (wire
   * `available_commands_update`). Full-replacement semantics — the wire
   * notification always carries the complete list. An empty list clears the
   * commands; the composer's `/` autocomplete reads from this.
   */
  | { sessionUpdate: 'commands_update'; commands: AcpAvailableCommand[]; raw?: SessionNotification }
  /**
   * The agent's config options arrived with the session (session/new ·
   * session/load result `configOptions`). Not a wire notification — the
   * drivers translate the RPC result into this event, exactly like
   * modes_initialized. null = the agent advertises none.
   */
  | { sessionUpdate: 'config_options_initialized'; options: AcpConfigOption[] | null }
  /**
   * The config option list changed: an `available config_option_update`
   * notification (full replacement) or the confirmed result of
   * `session/set_config_option` (its response carries the updated list).
   */
  | { sessionUpdate: 'config_options_update'; options: AcpConfigOption[]; raw?: SessionNotification }
  /**
   * A known session-level update kind Panda recognizes but does not render
   * in the message flow (compaction, …). Recorded
   * as the latest raw notification of its kind — nothing is dropped.
   */
  | { sessionUpdate: 'session_state'; kind: AcpSessionLevelKind; raw: SessionNotification }
  /**
   * An unknown-to-Panda `sessionUpdate` kind, or a chunk whose only content
   * block is unsupported. Rendered as an unsupported fallback block and kept
   * in `unhandledNotifications`.
   */
  | { sessionUpdate: 'unsupported'; raw: SessionNotification }
  // -- permission lifecycle (session/request_permission, issue #18) -----------
  // Not wire notifications: the drivers translate the client-side RPC into
  // these events so the reducer folds permissions into the document like
  // every other session-scoped state.
  /**
   * The agent asked for permission. Concurrent requests coexist; if the
   * tool call has not arrived yet the reducer plants a placeholder tool
   * record that the later `tool_call` event merges into.
   */
  | { sessionUpdate: 'permission_requested'; request: PermissionRequest }
  /**
   * A permission settled — user answer or cancellation (turn cancel,
   * disconnect). The resolved record is kept in the document (status +
   * response); only the pending card disappears from the UI.
   */
  | { sessionUpdate: 'permission_resolved'; toolCallId: string; response: PermissionResponse }
  // -- elicitation lifecycle (elicitation/create RPC + elicitation/complete) ---
  // Same translation pattern as permissions: the drivers turn the client-side
  // RPC into these events so the reducer folds elicitations into the document.
  // Form and url requests share the record map; the url-only events below
  // carry the accept-is-not-final lifecycle (open → out-of-band → complete).
  | { sessionUpdate: 'elicitation_requested'; request: ElicitationRequest }
  | { sessionUpdate: 'elicitation_resolved'; elicitationId: string; response: ElicitationResponse }
  | { sessionUpdate: 'elicitation_url_opened'; elicitationId: string }
  | { sessionUpdate: 'elicitation_url_completed'; elicitationId: string }

/**
 * Session-level kinds mapped to `session_state` events (latest-wins recording,
 * no in-flow rendering). Single source of truth: adding a kind here updates
 * the wire mapping and the `latestNotifications` key type together.
 * `plan` / `plan_removed` / `plan_update` / `usage_update` / `mode` /
 * `compaction_update` / `compaction_summary_chunk` are session-level too but
 * own dedicated wire cases (compaction even owns a document field);
 * `available_commands` and `config_options` went further — dedicated wire
 * cases *and* dedicated document fields (`availableCommands` /
 * `configOptions`), so neither is part of this fallback channel.
 */
export const SESSION_STATE_KINDS = ['session_info_update'] as const;

/** All kinds that own a `latestNotifications` slot. */
export type AcpSessionLevelKind =
  | 'plan'
  | 'plan_removed'
  | 'usage_update'
  | 'mode'
  | (typeof SESSION_STATE_KINDS)[number];

/** Narrowing guard for the session-state kinds without a dedicated wire case. */
export function isSessionStateKind(kind: string): kind is (typeof SESSION_STATE_KINDS)[number] {
  return (SESSION_STATE_KINDS as readonly string[]).includes(kind);
}

// ---------------------------------------------------------------------------
// Session document (domain facts — render models live in the projector)
// ---------------------------------------------------------------------------

export type SessionStatus = 'idle' | 'running' | 'requires_action';

export type ToolCallStatus = AcpToolCallStatus | 'cancelled';

export type ToolCallState = {
  id: string;
  title: string;
  kind: AcpToolKind;
  status: ToolCallStatus;
  rawInput?: Record<string, unknown>;
  /** The tool's raw output object as last reported (protocol rawOutput). */
  rawOutput?: Record<string, unknown>;
  content: AcpToolCallContent[];
  locations: AcpToolCallLocation[];
  /** Raw notifications folded into this tool call (create + updates), arrival order. */
  rawNotifications?: SessionNotification[];
};

export type Block =
  | {
      kind: 'user_message';
      content: AcpContentBlock[];
      /** Set while the block is only a local optimistic echo, not protocol data. */
      optimistic?: true;
      /** Protocol-side messageId, recorded once the agent's echo matched. */
      protocolMessageId?: string;
      rawNotifications?: SessionNotification[];
    }
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
  | { kind: 'turn_notice'; stopReason: Exclude<AcpStopReason, 'end_turn'> }
  /**
   * A compaction reached a terminal state — a system row in the flow, so the
   * moment the context shrank stays visible (like turn_notice). Planted once
   * per compactionId by the reducer's status transition, never re-fired.
   */
  | { kind: 'compaction_notice'; compactionId: string; outcome: 'completed' | 'failed'; error: string | null }
  | { kind: 'unsupported'; notification: SessionNotification };

export type Turn = { id: string; blocks: Block[] };

export type Usage = {
  used: number;
  size: number;
  cost: AcpCost | null;
};

/** The folded state of one context compaction (patched per update). */
export type CompactionState = {
  status: AcpCompactionStatus;
  /** Retained summary content — appended by summary chunks, replaced by updates. */
  summary: AcpContentBlock[] | null;
  error: string | null;
};

export type SessionDocument = {
  turns: Turn[];
  status: SessionStatus;
  usage: Usage;
  /**
   * Session-level plan: latest-wins (the wire plan update replaces it, an
   * empty entries list or plan_removed clears it). Docked in the top-right
   * corner — plans are working state, not conversation flow.
   */
  plan: AcpPlanEntry[] | null;
  /**
   * Context compactions by their agent-owned compactionId (wire
   * `compaction_update` patch + `compaction_summary_chunk` appends). The
   * in_progress ones render as a live trailing row; terminal transitions
   * plant a compaction_notice block in the flow.
   */
  compactions: Record<string, CompactionState>;
  /**
   * Session modes from the agent (session/new · session/load results, then
   * mode_changed updates). null until a result arrives — and permanently
   * null for agents that support no modes; the UI hides the picker then.
   */
  modes: AcpSessionModeState | null;
  /**
   * Permission lifecycle per tool call (issue #18), keyed by toolCallId and
   * kept for the whole session — pending requests render as cards, resolved
   * ones stay as records. Card order follows key insertion order: JS keeps
   * string keys in assignment order, so replayed sessions restore the
   * original card order (integer-like ids would sort numerically — a
   * reordering, never a loss).
   */
  permissions: Record<string, PermissionState>;
  /**
   * Elicitation lifecycle per request (form mode), keyed by the Panda-local
   * request id — pending render as form cards, settled ones stay as records.
   */
  elicitations: Record<string, ElicitationState>;
  /**
   * Slash commands advertised by the agent (wire `available_commands_update`,
   * full-replacement semantics — an empty update clears the list). The
   * composer's `/` autocomplete reads from this; `[]` hides the panel.
   */
  availableCommands: AcpAvailableCommand[];
  /**
   * Agent-advertised session config options (new/load result, then
   * config_option_update notifications and set_config_option responses —
   * all full-replacement). The composer's settings panel reads from this;
   * null/[] hides the entry point.
   */
  configOptions: AcpConfigOption[] | null;
  /**
   * Latest raw notification per session-level kind (plan/usage/mode/config/
   * session_info/…). Bounded by the kind set — history per kind is
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
// Permissions (session/request_permission, mirrored from the client side of
// the wire; the drivers translate the RPC into reducer events, issue #18).
// The four kinds are the exact ACP wire set.
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
  /** Tool kind from the wire's toolCall, for placeholder tool records. */
  kind?: AcpToolKind;
  options: PermissionOption[];
};

/**
 * How a permission settled — the chosen option, a cancellation, or a host
 * policy denial (issue #22): `denied-by-policy` marks a settlement the user
 * never decided; `kind` is the reject option answered on the wire, null when
 * the agent offered no reject option and was answered cancelled.
 */
export type PermissionResponse =
  | { outcome: 'selected'; kind: PermissionOptionKind }
  | { outcome: 'cancelled' }
  | { outcome: 'denied-by-policy'; kind: PermissionOptionKind | null };

/** The policy-denial variant, extracted for the UI's terminal card. */
export type DeniedPermissionResponse = Extract<PermissionResponse, { outcome: 'denied-by-policy' }>;

/** One permission's lifecycle state, session-scoped in the document. */
export type PermissionState = {
  status: 'pending' | 'resolved' | 'cancelled';
  request: PermissionRequest;
  /** Settled outcome; null while pending. */
  response: PermissionResponse | null;
};
