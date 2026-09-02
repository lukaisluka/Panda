import type {
  ContentBlock,
  RequestPermissionRequest,
  SessionUpdate,
  ToolCall,
  ToolCallContent,
  ToolCallLocation,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import type {
  AcpContentBlock,
  AcpSessionUpdate,
  AcpToolCallContent,
  AcpToolCallLocation,
  PermissionRequest,
} from '../protocol/types';

/**
 * Wire → internal mapping: folds the SDK's v1 `SessionUpdate` variants into
 * Panda's `AcpSessionUpdate` rendering subset.
 *
 * Conscious subset (documented, not errors — anything outside it is logged
 * and skipped so nothing disappears silently):
 *  - Chunk content supports text and image; audio/resource blocks are skipped.
 *  - Tool-call content supports `content` (text/image) and `diff`; `terminal`
 *    content is skipped. Content sent on a `tool_call` create is re-emitted as
 *    a follow-up `tool_call_update` (the rendering model only accepts content
 *    there).
 *  - `tool_call_update` consumes title/status/content/locations only; `kind`
 *    and `rawInput`/`rawOutput` on updates are dropped (the rendering model
 *    does not patch them).
 *  - Variants Panda does not render at all (plan_update, current_mode_update,
 *    compaction_*, session_info_update, …) warn and skip.
 */

const warn = (message: string) => console.warn(`[panda/acp] ${message}`);

function toContentBlock(block: ContentBlock, context: string): AcpContentBlock | null {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'image') return { type: 'image', data: block.data, mimeType: block.mimeType };
  warn(`${context}: content block "${block.type}" not supported yet — skipped`);
  return null;
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
      warn(`tool_call ${toolCallId}: content type "terminal" not supported yet — skipped`);
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

function toToolCall(call: ToolCall): AcpSessionUpdate[] {
  const created: AcpSessionUpdate = {
    sessionUpdate: 'tool_call',
    toolCallId: call.toolCallId,
    title: call.title,
    kind: call.kind,
    status: call.status,
    rawInput: toRawInput(call.rawInput, call.toolCallId),
    locations: toToolLocations(call.locations),
  };
  // The wire allows content on the create event, but the rendering model only
  // accepts it on updates — emit a follow-up so nothing is silently dropped.
  const content = toToolContent(call.content, call.toolCallId);
  if (content === undefined) return [created];
  return [created, { sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, content }];
}

function toToolCallUpdate(call: ToolCallUpdate): AcpSessionUpdate {
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: call.toolCallId,
    title: call.title ?? undefined,
    status: call.status ?? undefined,
    content: toToolContent(call.content, call.toolCallId),
    locations: toToolLocations(call.locations),
  };
}

/** Maps one wire `session/update` payload; empty array means "logged and skipped". */
export function toAcpUpdates(update: SessionUpdate): AcpSessionUpdate[] {
  switch (update.sessionUpdate) {
    case 'user_message_chunk': {
      const block = toContentBlock(update.content, 'user_message_chunk');
      return block ? [{ sessionUpdate: 'user_message', content: [block] }] : [];
    }
    case 'agent_message_chunk': {
      const block = toContentBlock(update.content, 'agent_message_chunk');
      return block
        ? [{ sessionUpdate: 'agent_message_chunk', messageId: update.messageId ?? undefined, content: block }]
        : [];
    }
    case 'agent_thought_chunk': {
      const block = toContentBlock(update.content, 'agent_thought_chunk');
      return block
        ? [{ sessionUpdate: 'agent_thought_chunk', messageId: update.messageId ?? undefined, content: block }]
        : [];
    }
    case 'tool_call':
      return toToolCall(update);
    case 'tool_call_update':
      return [toToolCallUpdate(update)];
    case 'plan':
      return [
        {
          sessionUpdate: 'plan',
          entries: update.entries.map(({ content, priority, status }) => ({ content, priority, status })),
        },
      ];
    case 'usage_update':
      return [
        {
          sessionUpdate: 'usage_update',
          used: update.used,
          size: update.size,
          cost: update.cost ?? undefined,
        },
      ];
    default:
      warn(`sessionUpdate "${update.sessionUpdate}" not supported yet — skipped`);
      return [];
  }
}

/** Maps a wire `session/request_permission` request to the UI card model. */
export function toPermissionRequest(request: RequestPermissionRequest): PermissionRequest {
  return {
    toolCallId: request.toolCall.toolCallId,
    title: request.toolCall.title ?? '未命名操作',
    options: request.options.map((option) => ({
      id: option.optionId,
      name: option.name,
      kind: option.kind,
    })),
  };
}