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
  AcpPlanEntry,
  AcpSessionLevelKind,
  AcpSessionUpdate,
  Block,
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
          status: update.status ?? existing.status,
          content: update.content ?? existing.content,
          locations: update.locations ?? existing.locations,
        },
        update.raw,
      );
      return upsertToolCall(doc, merged);
    }

    case 'plan':
      return withLatest(updatePlan(doc, update.entries), 'plan', update.raw);

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

    case 'session_state':
      return withLatest(doc, update.kind, update.raw);

    case 'unsupported':
      return appendUnsupported(doc, update.raw);
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
 * protocol-confirmed. An event that cannot find its block is a client/reducer
 * contract violation — surfaced loudly, never silently applied elsewhere.
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
  let confirmed: Block = {
    ...rest,
    ...(update.protocolMessageId ? { protocolMessageId: update.protocolMessageId } : {}),
  };
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

/** Plan is turn-scoped: update the current turn's plan block in place. */
function updatePlan(doc: SessionDocument, entries: AcpPlanEntry[]): SessionDocument {
  if (doc.turns.length === 0) {
    console.warn('[reducer] plan arrived outside of any turn; dropped');
    return doc;
  }
  const turn = currentTurn(doc)!;
  const planIndex = turn.blocks.findIndex((b) => b.kind === 'plan');
  const blocks: Block[] =
    planIndex >= 0
      ? turn.blocks.map((b, i) => (i === planIndex ? { kind: 'plan', entries } : b))
      : [...turn.blocks, { kind: 'plan', entries }];
  return replaceLastTurn(doc, { ...turn, blocks });
}
