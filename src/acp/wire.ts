import type {
  ClientApp,
  ContentBlock,
  RequestPermissionRequest,
  SessionNotification,
  SessionUpdate,
  ToolCall,
  ToolCallContent,
  ToolCallLocation,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import {
  isSessionStateKind,
  type AcpContentBlock,
  type AcpSessionUpdate,
  type AcpToolCallContent,
  type AcpToolCallLocation,
  type PermissionRequest,
} from '../protocol/types';

/**
 * Wire → internal mapping: folds the SDK's v1 `SessionUpdate` variants into
 * Panda's `AcpSessionUpdate` rendering subset. Nothing is ever dropped:
 *
 *  - Every mapped event carries its source `SessionNotification` as `raw`,
 *    so the document preserves protocol data by ownership (message blocks,
 *    tool calls, session-level latest) even where rendering is partial —
 *    e.g. audio/resource content blocks or `terminal` tool content are not
 *    rendered, but their notification stays attached to the owning entity.
 *  - A chunk whose only content block is unsupported (audio/resource)
 *    becomes an explicit `unsupported` event: rendered as a fallback block
 *    and kept in the document.
 *  - Session-level kinds Panda recognizes but does not render in the flow
 *    (modes, config, commands, compaction, …) become `session_state` events
 *    recorded as the latest raw notification of their kind.
 *  - Unknown `sessionUpdate` kinds (future protocol versions, vendor
 *    extensions) become `unsupported` events — logged loudly, never lost.
 *
 *  - Content sent on a `tool_call` create is re-emitted as a follow-up
 *    `tool_call_update` (the rendering model only accepts content there);
 *    the raw notification is attributed to the create event only, so it is
 *    attached exactly once.
 */

const warn = (message: string) => console.warn(`[panda/acp] ${message}`);

/**
 * Lenient parser for `session/update` notification params, registered in place
 * of the SDK's strict zod schema. The SDK parses params before any handler
 * runs and, when the parse throws, just console.errors the raw message and
 * drops it — which would silently lose unknown `sessionUpdate` kinds, the
 * exact forward-compat case the raw-preservation model exists for. This
 * public API seam (`onNotification(method, parser, handler)`) is the only
 * delivery path for schema-invalid notifications.
 *
 * Contract: a structurally sound notification (`sessionId` string, `update`
 * object with a `sessionUpdate` string) passes through unvalidated — kind
 * interpretation happens once, in `toAcpUpdates` below. Anything else throws,
 * and the SDK then logs the raw message while the connection survives.
 * Field-level validation of known kinds is traded away consciously: a
 * malformed known kind now fails inside `toAcpUpdates` with the same
 * loud-drop outcome, just with our stack trace instead of zod's.
 */
export function parseSessionNotification(params: unknown): SessionNotification {
  if (typeof params !== 'object' || params === null) {
    throw new Error(`session/update params is not an object: ${JSON.stringify(params)}`);
  }
  const { sessionId, update } = params as { sessionId?: unknown; update?: unknown };
  if (typeof sessionId !== 'string') {
    throw new Error(`session/update has no valid sessionId: ${JSON.stringify(params)}`);
  }
  if (
    typeof update !== 'object' ||
    update === null ||
    typeof (update as { sessionUpdate?: unknown }).sessionUpdate !== 'string'
  ) {
    throw new Error(`session/update has no valid update.sessionUpdate: ${JSON.stringify(params)}`);
  }
  return params as SessionNotification;
}

/**
 * Removes the SDK's built-in `client-session-update-router` from the app's
 * handler chain. That router runs before any app-registered handler and
 * strictly zod-parses every `session/update` notification; on failure the
 * connection layer console.errors and drops the message — so unknown
 * `sessionUpdate` kinds would never even reach `parseSessionNotification`.
 * The router only feeds the SDK's `ActiveSession`/attach helpers
 * (`connection.agent.session(...)`), which Panda does not use — it talks raw
 * `session/*` requests — so removing it loses nothing.
 *
 * `ClientApp.builder` is private API: if its shape changes on an SDK upgrade,
 * the filter no-ops, which is detected and reported loudly. Raw preservation
 * of unknown kinds then degrades to the SDK's drop-with-console.error
 * behavior, but the connection itself keeps working.
 */
export function removeSdkStrictSessionUpdateRouter(app: ClientApp): void {
  const builder = (app as unknown as {
    builder?: { handlers?: { describe?: () => string }[] };
  }).builder;
  if (!builder || !Array.isArray(builder.handlers)) {
    console.error(
      '[panda/acp] cannot remove the SDK strict session/update router ' +
        '(SDK private builder shape changed?) — unknown sessionUpdate kinds ' +
        'will be dropped by the SDK',
    );
    return;
  }
  const before = builder.handlers.length;
  builder.handlers = builder.handlers.filter(
    (handler) => handler.describe?.() !== 'client-session-update-router',
  );
  if (builder.handlers.length === before) {
    console.error(
      '[panda/acp] failed to remove the SDK strict session/update router ' +
        '(SDK private builder shape changed?) — unknown sessionUpdate kinds ' +
        'will be dropped by the SDK',
    );
  }
}

function toContentBlock(block: ContentBlock, context: string): AcpContentBlock | null {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'image') return { type: 'image', data: block.data, mimeType: block.mimeType };
  warn(`${context}: content block "${block.type}" not supported yet — preserved as raw only`);
  return null;
}

// ---------------------------------------------------------------------------
// Echo reconciliation (issue #15)
// ---------------------------------------------------------------------------

/** Order-insensitive structural equality — JSON.stringify would be key-order sensitive. */
function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => deepEqual(item, right[index]))
    );
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        deepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
    )
  );
}

/** Folds adjacent text blocks so a segmented echo compares as one message. */
function coalesceText(blocks: readonly AcpContentBlock[]): AcpContentBlock[] {
  const result: AcpContentBlock[] = [];
  for (const block of blocks) {
    const previous = result.at(-1);
    if (block.type === 'text' && previous?.type === 'text') {
      result[result.length - 1] = { type: 'text', text: previous.text + block.text };
    } else {
      result.push(block);
    }
  }
  return result;
}

export type EchoRelation = 'prefix' | 'equal' | 'different';

/**
 * Compares the content the client sent (`prompt`, internal blocks) against
 * the echo the agent has produced so far (wire `user_message_chunk` contents).
 * Text allows a trailing partial (`prefix` — echo still streaming); anything
 * else must match structurally. An echo containing content Panda cannot map
 * (audio/…) can never equal a prompt Panda sent, so it counts as `different`.
 */
export function echoRelation(
  prompt: readonly AcpContentBlock[],
  echoChunks: readonly ContentBlock[],
): EchoRelation {
  const mapped: (AcpContentBlock | null)[] = echoChunks.map((chunk) =>
    toContentBlock(chunk, 'echo reconciliation'),
  );
  if (mapped.some((block) => block === null)) return 'different';
  const expected = coalesceText(prompt);
  const actual = coalesceText(mapped as AcpContentBlock[]);

  if (actual.length > expected.length) return 'different';
  for (let index = 0; index < actual.length; index += 1) {
    const incoming = actual[index]!;
    const target = expected[index];
    if (!target || incoming.type !== target.type) return 'different';
    if (incoming.type === 'text' && target.type === 'text') {
      const last = index === actual.length - 1;
      if (last ? !target.text.startsWith(incoming.text) : target.text !== incoming.text) {
        return 'different';
      }
    } else if (!deepEqual(incoming, target)) {
      return 'different';
    }
  }
  if (actual.length !== expected.length) return 'prefix';
  const lastActual = actual.at(-1);
  const lastExpected = expected.at(-1);
  if (lastActual?.type === 'text' && lastExpected?.type === 'text') {
    return lastActual.text === lastExpected.text ? 'equal' : 'prefix';
  }
  return 'equal';
}

function toRawInput(rawInput: unknown, toolCallId: string): Record<string, unknown> | undefined {
  if (rawInput == null) return undefined;
  if (typeof rawInput === 'object' && !Array.isArray(rawInput)) return rawInput as Record<string, unknown>;
  warn(`tool_call ${toolCallId}: rawInput is not a JSON object — dropped`);
  return undefined;
}

function toToolContent(items: ToolCallContent[] | null | undefined, toolCallId: string): AcpToolCallContent[] | undefined {
  if (items == null) return undefined;
  const mapped: AcpToolCallContent[] = [];
  for (const item of items) {
    if (item.type === 'diff') {
      mapped.push({ type: 'diff', path: item.path, oldText: item.oldText ?? null, newText: item.newText });
    } else if (item.type === 'content') {
      const content = toContentBlock(item.content, `tool_call ${toolCallId} content`);
      if (content) mapped.push({ type: 'content', content });
    } else {
      warn(`tool_call ${toolCallId}: content type "terminal" not supported yet — preserved as raw only`);
    }
  }
  return mapped;
}

function toToolLocations(
  locations: ToolCallLocation[] | null | undefined,
): AcpToolCallLocation[] | undefined {
  if (locations == null) return undefined;
  return locations.map(({ path, line }) => ({ path, line: line ?? undefined }));
}

function toToolCall(call: ToolCall, raw: SessionNotification): AcpSessionUpdate[] {
  const created: AcpSessionUpdate = {
    sessionUpdate: 'tool_call',
    toolCallId: call.toolCallId,
    title: call.title,
    kind: call.kind,
    status: call.status,
    rawInput: toRawInput(call.rawInput, call.toolCallId),
    locations: toToolLocations(call.locations),
    raw,
  };
  // The wire allows content on the create event, but the rendering model only
  // accepts it on updates — emit a follow-up so nothing is silently dropped.
  const content = toToolContent(call.content, call.toolCallId);
  if (content === undefined) return [created];
  return [created, { sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, content }];
}

function toToolCallUpdate(call: ToolCallUpdate, raw: SessionNotification): AcpSessionUpdate {
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: call.toolCallId,
    title: call.title ?? undefined,
    status: call.status ?? undefined,
    content: toToolContent(call.content, call.toolCallId),
    locations: toToolLocations(call.locations),
    raw,
  };
}

/** Maps one wire `session/update` notification; the result is never empty-lossy — unsupported data becomes explicit events. */
export function toAcpUpdates(notification: SessionNotification): AcpSessionUpdate[] {
  const update: SessionUpdate = notification.update;
  const raw = notification;
  switch (update.sessionUpdate) {
    case 'user_message_chunk': {
      const block = toContentBlock(update.content, 'user_message_chunk');
      return block
        ? [{ sessionUpdate: 'user_message', content: [block], raw }]
        : [{ sessionUpdate: 'unsupported', raw }];
    }
    case 'agent_message_chunk': {
      const block = toContentBlock(update.content, 'agent_message_chunk');
      return block
        ? [{ sessionUpdate: 'agent_message_chunk', messageId: update.messageId ?? undefined, content: block, raw }]
        : [{ sessionUpdate: 'unsupported', raw }];
    }
    case 'agent_thought_chunk': {
      const block = toContentBlock(update.content, 'agent_thought_chunk');
      return block
        ? [{ sessionUpdate: 'agent_thought_chunk', messageId: update.messageId ?? undefined, content: block, raw }]
        : [{ sessionUpdate: 'unsupported', raw }];
    }
    case 'tool_call':
      return toToolCall(update, raw);
    case 'tool_call_update':
      return [toToolCallUpdate(update, raw)];
    case 'plan':
      return [
        {
          sessionUpdate: 'plan',
          entries: update.entries.map(({ content, priority, status }) => ({ content, priority, status })),
          raw,
        },
      ];
    case 'usage_update':
      return [
        {
          sessionUpdate: 'usage_update',
          used: update.used,
          size: update.size,
          cost: update.cost ?? undefined,
          raw,
        },
      ];
    default: {
      // Recognized session-level kinds without in-flow rendering: keep the
      // latest raw notification of each kind (list owned by types.ts).
      if (isSessionStateKind(update.sessionUpdate)) {
        return [{ sessionUpdate: 'session_state', kind: update.sessionUpdate, raw }];
      }
      warn(`sessionUpdate "${(update as { sessionUpdate: string }).sessionUpdate}" not supported yet — preserved as unsupported`);
      return [{ sessionUpdate: 'unsupported', raw }];
    }
  }
}

/** Maps a wire `session/request_permission` request to the UI card model. */
export function toPermissionRequest(request: RequestPermissionRequest): PermissionRequest {
  return {
    toolCallId: request.toolCall.toolCallId,
    title: request.toolCall.title ?? '未命名操作',
    kind: request.toolCall.kind ?? undefined,
    options: request.options.map((option) => ({
      id: option.optionId,
      name: option.name,
      kind: option.kind,
    })),
  };
}
