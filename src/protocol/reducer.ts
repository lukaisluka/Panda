/**
 * The reduction layer: folds ACP session/update events into a SessionDocument.
 *
 * Pure function, no framework imports, fully unit-testable and replayable —
 * the same doc fed the same event sequence always yields the same document.
 * Every UI component reads the output document only; this seam is what lets
 * the visual layer be iterated on without touching protocol logic.
 */

import type {
  AcpContentBlock,
  AcpSessionLevelKind,
  AcpSessionUpdate,
  Block,
  PermissionRequest,
  PermissionResponse,
  SessionDocument,
  SessionNotification,
  ToolCallState,
  Turn,
} from './types';

export function emptySession(): SessionDocument {
  return {
    turns: [],
    status: 'idle',
    usage: { used: 0, size: 0, cost: null },
    plan: null,
    compactions: {},
    modes: null,
    availableCommands: [],
    configOptions: null,
    permissions: {},
    elicitations: {},
    latestNotifications: {},
    unhandledNotifications: [],
  };
}

export function applyUpdate(
  doc: SessionDocument,
  update: AcpSessionUpdate,
): SessionDocument {
  switch (update.sessionUpdate) {
    case 'user_message':
      return appendUserMessage(doc, update.content, update.raw, update.optimistic);

    case 'user_message_confirmed':
      return confirmUserMessage(doc, update);

    case 'agent_message_chunk':
      return appendChunk(doc, 'agent_message', update.messageId, update.content, update.raw);

    case 'agent_thought_chunk':
      return appendChunk(doc, 'thought', update.messageId, update.content, update.raw);

    case 'tool_call':
      return upsertToolCall(
        doc,
        withRaw(
          {
            id: update.toolCallId,
            title: update.title,
            kind: update.kind ?? 'other',
            status: update.status ?? 'pending',
            rawInput: update.rawInput,
            content: [],
            locations: update.locations ?? [],
          },
          update.raw,
        ),
      );

    case 'tool_call_update': {
      const existing = findToolCall(doc, update.toolCallId);
      if (!existing) {
        // Updates may only reference calls whose creation event arrived before;
        // surface a broken replay loudly instead of dropping it silently.
        console.warn(`[reducer] tool_call_update for unknown toolCallId: ${update.toolCallId}`);
        return doc;
      }
      const merged = withRaw(
        {
          ...existing,
          title: update.title ?? existing.title,
          kind: update.kind ?? existing.kind,
          status: update.status ?? existing.status,
          content: update.content ?? existing.content,
          locations: update.locations ?? existing.locations,
          rawInput: update.rawInput ?? existing.rawInput,
          rawOutput: update.rawOutput ?? existing.rawOutput,
        },
        update.raw,
      );
      return upsertToolCall(doc, merged);
    }

    case 'plan':
      // Session-level latest-wins (docked UI): the update replaces the plan,
      // an empty entries list withdraws it. Plans never enter the flow.
      return withLatest(
        { ...doc, plan: update.entries.length > 0 ? update.entries : null },
        'plan',
        update.raw,
      );

    case 'plan_removed':
      return withLatest({ ...doc, plan: null }, 'plan_removed', update.raw);

    case 'usage_update':
      return withLatest(
        {
          ...doc,
          usage: {
            used: update.used,
            size: update.size,
            cost: update.cost ?? doc.usage.cost,
          },
        },
        'usage_update',
        update.raw,
      );

    case 'status_changed':
      // Idempotent fold: an unchanged value keeps the doc's identity — the
      // projector/memo contract (ADR 0006) survives redundant convergence.
      if (doc.status === update.status) return doc;
      return { ...doc, status: update.status };

    case 'turn_notice':
      // Stays inside the turn that just ended — a system row, never a new turn.
      return appendBlock(doc, { kind: 'turn_notice', stopReason: update.stopReason }, false);

    case 'compaction_update': {
      // Patch fold per compactionId: omitted fields keep the stored value,
      // null clears, a value replaces. Terminal transitions (→ completed /
      // failed) plant one notice block in the flow — the moment the context
      // shrank must stay visible, and a re-sent terminal status must not
      // duplicate the row.
      const prev = doc.compactions[update.compactionId];
      const summary = update.summary !== undefined ? update.summary : (prev?.summary ?? null);
      const error = update.error !== undefined ? update.error : (prev?.error ?? null);
      const patched: SessionDocument = {
        ...doc,
        compactions: {
          ...doc.compactions,
          [update.compactionId]: { status: update.status, summary, error },
        },
      };
      if (prev?.status !== 'completed' && update.status === 'completed') {
        return appendBlock(
          patched,
          { kind: 'compaction_notice', compactionId: update.compactionId, outcome: 'completed', error },
          false,
        );
      }
      if (prev?.status !== 'failed' && update.status === 'failed') {
        return appendBlock(
          patched,
          { kind: 'compaction_notice', compactionId: update.compactionId, outcome: 'failed', error },
          false,
        );
      }
      return patched;
    }

    case 'compaction_summary_chunk': {
      // Appends to the retained summary. Chunks belong after an in_progress
      // compaction_update (spec); one that arrives first still folds —
      // planted as in_progress so the completed notice's summary is whole.
      const prev = doc.compactions[update.compactionId];
      if (!prev) {
        console.warn(
          `[reducer] compaction_summary_chunk for unknown compactionId: ${update.compactionId} — planted as in_progress`,
        );
      }
      const summary = [...(prev?.summary ?? []), update.content];
      return {
        ...doc,
        compactions: {
          ...doc.compactions,
          [update.compactionId]: {
            status: prev?.status ?? 'in_progress',
            summary,
            error: prev?.error ?? null,
          },
        },
      };
    }

    case 'modes_initialized':
      return { ...doc, modes: update.modes };

    case 'mode_changed':
      // Without advertised modes there is no state to move — an agent that
      // never declared modes yet switches one is violating the protocol, so
      // record the notification but leave the document untouched (loud).
      if (!doc.modes) {
        console.warn(`[reducer] mode_changed to "${update.modeId}" without advertised modes — recorded only`);
        return withLatest(doc, 'mode', update.raw);
      }
      return withLatest(
        { ...doc, modes: { ...doc.modes, currentModeId: update.modeId } },
        'mode',
        update.raw,
      );

    case 'commands_update':
      // Full replacement — the wire notification always carries the complete
      // list, so an empty update clears the commands.
      return { ...doc, availableCommands: update.commands };

    case 'config_options_initialized':
    case 'config_options_update':
      // Both sources are full-replacement: the new/load result, the
      // config_option_update notification, and the set_config_option
      // response all carry the complete list.
      return { ...doc, configOptions: update.options };

    case 'session_state':
      return withLatest(doc, update.kind, update.raw);

    case 'unsupported':
      return appendUnsupported(doc, update.raw);

    case 'permission_requested':
      return requestPermission(doc, update.request);

    case 'permission_resolved':
      return resolvePermission(doc, update.toolCallId, update.response);

    case 'elicitation_requested': {
      // The agent must keep wire elicitationIds unique among unfinished url
      // elicitations; a repeat (or a collision with a local form mint) would
      // overwrite a live record — keep the first, log the violation.
      if (doc.elicitations[update.request.id]) {
        console.warn(`[reducer] elicitation_requested reuses live id ${update.request.id} — ignored`);
        return doc;
      }
      return {
        ...doc,
        elicitations: {
          ...doc.elicitations,
          [update.request.id]: { status: 'pending', request: update.request, response: null },
        },
      };
    }

    case 'elicitation_resolved': {
      const existing = doc.elicitations[update.elicitationId];
      if (!existing) {
        console.warn(`[reducer] elicitation_resolved for unknown id ${update.elicitationId} — ignored`);
        return doc;
      }
      if (existing.status !== 'pending') {
        console.warn(
          `[reducer] elicitation_resolved for ${update.elicitationId} in status ${existing.status} — ignored`,
        );
        return doc;
      }
      return {
        ...doc,
        elicitations: {
          ...doc.elicitations,
          [update.elicitationId]: {
            ...existing,
            status: update.response.outcome === 'cancelled' ? 'cancelled' : 'resolved',
            response: update.response,
          },
        },
      };
    }

    case 'elicitation_url_opened': {
      const existing = doc.elicitations[update.elicitationId];
      if (!existing || existing.status !== 'pending') {
        console.warn(
          `[reducer] elicitation_url_opened for ${update.elicitationId} in status ${existing?.status ?? 'unknown'} — ignored`,
        );
        return doc;
      }
      return {
        ...doc,
        elicitations: {
          ...doc.elicitations,
          [update.elicitationId]: { ...existing, status: 'opened' },
        },
      };
    }

    case 'elicitation_url_completed': {
      // Spec: the client must ignore complete notifications for unknown or
      // already-finished elicitations — the reducer is that gatekeeper.
      const existing = doc.elicitations[update.elicitationId];
      if (!existing || (existing.status !== 'pending' && existing.status !== 'opened')) {
        console.warn(
          `[reducer] elicitation_url_completed for ${update.elicitationId} in status ${existing?.status ?? 'unknown'} — ignored`,
        );
        return doc;
      }
      return {
        ...doc,
        elicitations: {
          ...doc.elicitations,
          [update.elicitationId]: { ...existing, status: 'completed' },
        },
      };
    }
  }
}

/** Records the latest raw notification of a session-level kind, if present. */
function withLatest(
  doc: SessionDocument,
  kind: AcpSessionLevelKind,
  raw: SessionNotification | undefined,
): SessionDocument {
  if (!raw) return doc;
  return { ...doc, latestNotifications: { ...doc.latestNotifications, [kind]: raw } };
}

/**
 * Unknown-kind notifications: appended to the unhandled bucket and rendered
 * as an in-flow fallback block so their position in the conversation is
 * visible and the raw payload inspectable.
 */
function appendUnsupported(doc: SessionDocument, notification: SessionNotification): SessionDocument {
  const bucketed: SessionDocument = {
    ...doc,
    unhandledNotifications: [...doc.unhandledNotifications, notification],
  };
  return appendBlock(bucketed, { kind: 'unsupported', notification }, false);
}

/** Appends `raw` to a block's attribution list, keeping identity when absent. */
function withRaw<T extends object>(block: T, raw: SessionNotification | undefined): T {
  if (!raw) return block;
  const existing = (block as { rawNotifications?: SessionNotification[] }).rawNotifications;
  return { ...block, rawNotifications: [...(existing ?? []), raw] };
}

// ---------------------------------------------------------------------------
// Block plumbing
// ---------------------------------------------------------------------------

function currentTurn(doc: SessionDocument): Turn | undefined {
  return doc.turns.at(-1);
}

function replaceLastTurn(doc: SessionDocument, turn: Turn): SessionDocument {
  return { ...doc, turns: [...doc.turns.slice(0, -1), turn] };
}

/** Opens a new turn when `newTurn` is set, or when no turn exists yet. */
function appendBlock(doc: SessionDocument, block: Block, newTurn: boolean): SessionDocument {
  if (newTurn || doc.turns.length === 0) {
    const turn: Turn = { id: `turn-${doc.turns.length + 1}`, blocks: [block] };
    return { ...doc, turns: [...doc.turns, turn] };
  }
  const turn = currentTurn(doc)!;
  return replaceLastTurn(doc, { ...turn, blocks: [...turn.blocks, block] });
}

/**
 * ACP replays a multipart prompt as adjacent `user_message_chunk` events.
 * Keep those parts in one user block — but never merge into a block that is
 * (or was) a local optimistic echo: reconciliation owns that block's content,
 * so a divergent or flushed protocol echo must render as its own block.
 */
function appendUserMessage(
  doc: SessionDocument,
  content: AcpContentBlock[],
  raw: SessionNotification | undefined,
  optimistic?: true,
): SessionDocument {
  const turn = currentTurn(doc);
  const last = turn?.blocks.at(-1);
  const mergeable =
    last?.kind === 'user_message' && last.optimistic !== true && last.protocolMessageId === undefined;
  if (turn && mergeable) {
    const blocks: Block[] = [
      ...turn.blocks.slice(0, -1),
      withRaw({ ...last, content: [...last.content, ...content] }, raw),
    ];
    return replaceLastTurn(doc, { ...turn, blocks });
  }
  const block: Block = withRaw(
    optimistic ? { kind: 'user_message', content, optimistic: true } : { kind: 'user_message', content },
    raw,
  );
  // A local prompt always opens a turn. A protocol message rendering while
  // another user block still trails the turn (flushed divergent echo, late
  // echo after confirmation) stays in the same turn as its own block.
  if (!optimistic && turn && last?.kind === 'user_message') {
    return replaceLastTurn(doc, { ...turn, blocks: [...turn.blocks, block] });
  }
  return appendBlock(doc, block, true);
}

/**
 * Equal-echo reconciliation: the trailing optimistic user block becomes
 * protocol-confirmed. With a protocol messageId the block drops its local
 * marker and becomes indistinguishable from a replayed one; without one the
 * marker stays — either way the block stays locked against merging (it is or
 * was a local echo; only reconciliation owns its content). An event that
 * cannot find its block is a client/reducer contract violation — surfaced
 * loudly, never silently applied elsewhere.
 */
function confirmUserMessage(
  doc: SessionDocument,
  update: Extract<AcpSessionUpdate, { sessionUpdate: 'user_message_confirmed' }>,
): SessionDocument {
  const turn = currentTurn(doc);
  const last = turn?.blocks.at(-1);
  if (!turn || !last || last.kind !== 'user_message' || last.optimistic !== true) {
    console.warn('[reducer] user_message_confirmed without a trailing optimistic user block — ignored');
    return doc;
  }
  const { optimistic: _dropped, ...rest } = last;
  let confirmed: Block = update.protocolMessageId
    ? { ...rest, protocolMessageId: update.protocolMessageId }
    : { ...last };
  for (const notification of update.notifications) {
    confirmed = withRaw(confirmed, notification);
  }
  return replaceLastTurn(doc, { ...turn, blocks: [...turn.blocks.slice(0, -1), confirmed] });
}

/**
 * Appends a streaming chunk (text or image) to the immediately preceding,
 * matching block in the current turn. A live ACP stream may omit messageId;
 * in that case only an adjacent block can be the same message. Looking across
 * turns would attach a later response to an earlier user prompt.
 */
function appendChunk(
  doc: SessionDocument,
  blockKind: 'agent_message' | 'thought',
  messageId: string | undefined,
  chunk: AcpContentBlock,
  raw: SessionNotification | undefined,
): SessionDocument {
  const lastBlock = currentTurn(doc)?.blocks.at(-1);
  if (
    lastBlock?.kind === blockKind &&
    (messageId === undefined || lastBlock.messageId === messageId)
  ) {
    const turn = currentTurn(doc)!;
    const blocks: Block[] = turn.blocks.map((b) => {
      if ((b.kind === 'agent_message' || b.kind === 'thought') && b === lastBlock) {
        return withRaw({ ...b, parts: appendPart(b.parts, chunk) }, raw);
      }
      return b;
    });
    return replaceLastTurn(doc, { ...turn, blocks });
  }

  const base =
    blockKind === 'agent_message'
      ? { kind: 'agent_message' as const, messageId: messageId ?? autoMessageId(doc, 'msg'), parts: [chunk] }
      : { kind: 'thought' as const, messageId: messageId ?? autoMessageId(doc, 'thought'), parts: [chunk] };
  const block: Block = withRaw(base, raw);
  return appendBlock(doc, block, false);
}

/**
 * Text chunks merge into the adjacent trailing text part (streaming concat);
 * images are atomic and always open a new part.
 */
function appendPart(parts: AcpContentBlock[], chunk: AcpContentBlock): AcpContentBlock[] {
  const last = parts.at(-1);
  if (chunk.type === 'text' && last?.type === 'text') {
    return [...parts.slice(0, -1), { type: 'text', text: last.text + chunk.text }];
  }
  return [...parts, chunk];
}

/** Deterministic fallback id (wire events without messageId) to keep the reducer replayable. */
function autoMessageId(doc: SessionDocument, prefix: string): string {
  const blockCount = doc.turns.reduce((n, turn) => n + turn.blocks.length, 0);
  return `${prefix}-${blockCount + 1}`;
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

function findToolCall(doc: SessionDocument, toolCallId: string): ToolCallState | undefined {
  for (let i = doc.turns.length - 1; i >= 0; i--) {
    const blocks = doc.turns[i]!.blocks;
    for (let j = blocks.length - 1; j >= 0; j--) {
      const block = blocks[j]!;
      if (block.kind === 'tool_call' && block.call.id === toolCallId) return block.call;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Permission lifecycle (issue #18)
// ---------------------------------------------------------------------------

/**
 * Records a permission request and, when it arrives before its `tool_call`
 * event (out-of-order — the RPC can precede the notification), plants a
 * placeholder tool record so the card has a place to live; the later
 * `tool_call` merges into it via the normal upsert path.
 */
function requestPermission(doc: SessionDocument, request: PermissionRequest): SessionDocument {
  const withRecord: SessionDocument = {
    ...doc,
    permissions: {
      ...doc.permissions,
      [request.toolCallId]: { status: 'pending', request, response: null },
    },
  };
  if (findToolCall(withRecord, request.toolCallId)) return withRecord;
  return upsertToolCall(withRecord, {
    id: request.toolCallId,
    title: request.title,
    kind: request.kind ?? 'other',
    status: 'pending',
    content: [],
    locations: [],
  });
}

/**
 * Settles a permission: pending → resolved/cancelled with the response kept.
 * A resolve for an unknown toolCallId is a driver/reducer contract violation
 * — surfaced loudly, never silently applied. When the tool will never run
 * (cancelled, or the user picked a reject option), a still-pending tool
 * record is retired to `cancelled` — otherwise the placeholder planted for
 * an out-of-order request would linger as "awaiting approval" forever with
 * nothing left to answer it. A later real `tool_call` for the same id still
 * overwrites the record through the normal upsert path.
 */
function resolvePermission(
  doc: SessionDocument,
  toolCallId: string,
  response: PermissionResponse,
): SessionDocument {
  const existing = doc.permissions[toolCallId];
  if (!existing) {
    console.warn(`[reducer] permission_resolved for unknown toolCallId ${toolCallId} — ignored`);
    return doc;
  }
  const withRecord: SessionDocument = {
    ...doc,
    permissions: {
      ...doc.permissions,
      [toolCallId]: {
        ...existing,
        status: response.outcome === 'cancelled' ? 'cancelled' : 'resolved',
        response,
      },
    },
  };
  const toolWillNotRun =
    response.outcome === 'cancelled' ||
    response.outcome === 'denied-by-policy' ||
    (response.outcome === 'remembered' && response.kind === 'reject_always') ||
    (response.outcome === 'selected' &&
      (response.kind === 'reject_once' || response.kind === 'reject_always'));
  return toolWillNotRun ? retirePendingToolCall(withRecord, toolCallId) : withRecord;
}

/**
 * Marks a still-pending tool record cancelled. Reference-preserving when
 * nothing matches (or the call already started) so untouched turns keep
 * their identities for the memoized block views.
 */
function retirePendingToolCall(doc: SessionDocument, toolCallId: string): SessionDocument {
  let changed = false;
  const turns = doc.turns.map((turn) => {
    let blocksChanged = false;
    const blocks = turn.blocks.map((block) => {
      if (block.kind === 'tool_call' && block.call.id === toolCallId && block.call.status === 'pending') {
        blocksChanged = true;
        return { kind: 'tool_call' as const, call: { ...block.call, status: 'cancelled' as const } };
      }
      return block;
    });
    if (!blocksChanged) return turn;
    changed = true;
    return { ...turn, blocks };
  });
  return changed ? { ...doc, turns } : doc;
}

/**
 * Inserts a new tool-call block at the end of the current turn, or patches
 * the existing block in place. Order of arrival is preserved — cards show up
 * between the text that surrounds them, which is the honest shape of an
 * agentic conversation.
 */
function upsertToolCall(doc: SessionDocument, call: ToolCallState): SessionDocument {
  if (findToolCall(doc, call.id)) {
    const turns = doc.turns.map((turn) => ({
      ...turn,
      blocks: turn.blocks.map((b) =>
        b.kind === 'tool_call' && b.call.id === call.id ? { kind: 'tool_call' as const, call } : b,
      ),
    }));
    return { ...doc, turns };
  }
  if (doc.turns.length === 0) {
    console.warn(`[reducer] tool_call "${call.title}" arrived outside of any turn; dropped`);
    return doc;
  }
  const turn = currentTurn(doc)!;
  return replaceLastTurn(doc, {
    ...turn,
    blocks: [...turn.blocks, { kind: 'tool_call', call }],
  });
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------
