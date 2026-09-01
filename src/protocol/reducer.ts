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
  AcpSessionUpdate,
  Block,
  SessionDocument,
  ToolCallState,
  Turn,
} from './types';

export function emptySession(): SessionDocument {
  return {
    turns: [],
    status: 'idle',
    usage: { used: 0, size: 0, cost: null },
  };
}

export function applyUpdate(
  doc: SessionDocument,
  update: AcpSessionUpdate,
): SessionDocument {
  switch (update.sessionUpdate) {
    case 'user_message':
      return appendBlock(doc, { kind: 'user_message', content: update.content }, true);

    case 'agent_message_chunk':
      return appendTextChunk(doc, 'agent_message', update.messageId, update.content);

    case 'agent_thought_chunk':
      return appendTextChunk(doc, 'thought', update.messageId, update.content);

    case 'tool_call':
      return upsertToolCall(doc, {
        id: update.toolCallId,
        title: update.title,
        kind: update.kind ?? 'other',
        status: update.status ?? 'pending',
        rawInput: update.rawInput,
        content: [],
        locations: update.locations ?? [],
      });

    case 'tool_call_update': {
      const existing = findToolCall(doc, update.toolCallId);
      if (!existing) {
        // Updates may only reference calls whose creation event arrived before;
        // surface a broken replay loudly instead of dropping it silently.
        console.warn(`[reducer] tool_call_update for unknown toolCallId: ${update.toolCallId}`);
        return doc;
      }
      return upsertToolCall(doc, {
        ...existing,
        title: update.title ?? existing.title,
        status: update.status ?? existing.status,
        content: update.content ?? existing.content,
        locations: update.locations ?? existing.locations,
      });
    }

    case 'plan':
      return updatePlan(doc, update.entries);

    case 'usage_update':
      return {
        ...doc,
        usage: {
          used: update.used,
          size: update.size,
          cost: update.cost ?? doc.usage.cost,
        },
      };
  }
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
 * Appends a streaming text chunk to the last matching block of the current
 * conversation. messageId matches continue that message; a mismatched or new
 * id opens a new one. Without an id the chunk continues the last open block
 * (v1 makes the id optional for exactly this reason).
 */
function appendTextChunk(
  doc: SessionDocument,
  blockKind: 'agent_message' | 'thought',
  messageId: string | undefined,
  chunk: AcpContentBlock,
): SessionDocument {
  if (chunk.type !== 'text') return doc;

  const lastBlock = lastTextBlock(doc, blockKind);
  if (lastBlock && (messageId === undefined || lastBlock.messageId === messageId)) {
    const turn = currentTurn(doc)!;
    const blocks: Block[] = turn.blocks.map((b) => {
      if ((b.kind === 'agent_message' || b.kind === 'thought') && b === lastBlock) {
        return { ...b, md: b.md + chunk.text };
      }
      return b;
    });
    return replaceLastTurn(doc, { ...turn, blocks });
  }

  const block: Block =
    blockKind === 'agent_message'
      ? { kind: 'agent_message', messageId: messageId ?? autoMessageId(doc, 'msg'), md: chunk.text }
      : { kind: 'thought', messageId: messageId ?? autoMessageId(doc, 'thought'), md: chunk.text };
  return appendBlock(doc, block, false);
}

type TextBlock = Extract<Block, { kind: 'agent_message' } | { kind: 'thought' }>;

function lastTextBlock(doc: SessionDocument, kind: 'agent_message' | 'thought'): TextBlock | undefined {
  for (let i = doc.turns.length - 1; i >= 0; i--) {
    const blocks = doc.turns[i]!.blocks;
    for (let j = blocks.length - 1; j >= 0; j--) {
      const block = blocks[j]!;
      if (block.kind === kind) return block;
    }
  }
  return undefined;
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