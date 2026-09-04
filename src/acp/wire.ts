import type {
  BooleanPropertySchema,
  ClientApp,
  ContentBlock,
  CreateElicitationRequest,
  ElicitationFormMode,
  ElicitationUrlMode,
  IntegerPropertySchema,
  MultiSelectPropertySchema,
  NumberPropertySchema,
  RequestPermissionRequest,
  SessionNotification,
  SessionUpdate,
  StringMultiSelectItems,
  StringPropertySchema,
  TitledMultiSelectItems,
  ToolCall,
  ToolCallContent,
  ToolCallLocation,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import {
  isSessionStateKind,
  type AcpAvailableCommand,
  type AcpConfigChoice,
  type AcpConfigOption,
  type AcpContentBlock,
  type AcpElicitationField,
  type AcpElicitationOption,
  type AcpSessionModeState,
  type AcpSessionUpdate,
  type AcpToolCallContent,
  type AcpToolCallLocation,
  type ElicitationRequest,
  type PermissionRequest,
} from '../protocol/types';

/**
 * Wire → internal mapping: folds the SDK's v1 `SessionUpdate` variants into
 * Panda's `AcpSessionUpdate` rendering subset. Nothing is ever dropped:
 *
 *  - Every mapped event carries its source `SessionNotification` as `raw`,
 *    so the document preserves protocol data by ownership (message blocks,
 *    tool calls, session-level latest) even where rendering is partial —
 *    e.g. audio/resource content blocks or `terminal` tool content become
 *    explicit `unsupported` entries in the tool content list (rendered as a
 *    fallback row), and their notification stays attached to the owner.
 *  - A chunk whose only content block is unsupported (audio/resource)
 *    becomes an explicit `unsupported` event: rendered as a fallback block
 *    and kept in the document.
 *  - Session-level kinds Panda recognizes but does not render in the flow
 *    (config, commands, compaction, …) become `session_state` events
 *    recorded as the latest raw notification of their kind. Mode switches
 *    get a dedicated `mode_changed` event instead — they drive UI state.
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

/** Shared JSON-object guard for `rawInput`/`rawOutput`: the protocol types
 * them as unknown, but the rendering model only accepts plain objects. */
function toRawJson(value: unknown, toolCallId: string, field: string): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  warn(`tool_call ${toolCallId}: ${field} is not a JSON object — dropped`);
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
      else {
        // Not dropped: an explicit unsupported row keeps the stream honest
        // about blocks Panda cannot render (audio/resource/…).
        mapped.push({ type: 'unsupported', blockType: item.content.type });
      }
    } else {
      // e.g. terminal tool content (v1): same explicit-unsupported contract.
      warn(`tool_call ${toolCallId}: content type "${item.type}" not supported yet — shown as an unsupported row`);
      mapped.push({ type: 'unsupported', blockType: item.type });
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
    rawInput: toRawJson(call.rawInput, call.toolCallId, 'rawInput'),
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
    rawOutput: toRawJson(call.rawOutput, call.toolCallId, 'rawOutput'),
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
    case 'plan_removed':
      return [{ sessionUpdate: 'plan_removed', raw }];
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
    case 'current_mode_update': {
      // Field is `currentModeId` on the wire (SessionUpdate.currentModeId);
      // notifications are not schema-validated, so a malformed one surfaces as
      // unsupported instead of a silent no-op.
      const modeId = (update as { currentModeId?: unknown }).currentModeId;
      if (typeof modeId !== 'string') {
        warn('current_mode_update without a currentModeId string — preserved as unsupported');
        return [{ sessionUpdate: 'unsupported', raw }];
      }
      return [{ sessionUpdate: 'mode_changed', modeId, raw }];
    }
    case 'available_commands_update': {
      const commands = toAvailableCommands(update);
      if (commands === null) {
        warn('available_commands_update with a malformed availableCommands list — preserved as unsupported');
        return [{ sessionUpdate: 'unsupported', raw }];
      }
      return [{ sessionUpdate: 'commands_update', commands, raw }];
    }
    case 'config_option_update': {
      const options = toConfigOptions((update as { configOptions?: unknown }).configOptions);
      if (options === null) {
        warn('config_option_update with a malformed configOptions list — preserved as unsupported');
        return [{ sessionUpdate: 'unsupported', raw }];
      }
      return [{ sessionUpdate: 'config_options_update', options, raw }];
    }
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

/**
 * Whitelists the wire `available_commands_update` payload into the UI model.
 * Notifications are not schema-validated, so structural violations (the list
 * is not an array, an entry is not an object, `name`/`description` are not
 * strings, `input` is a non-object) reject the whole update (null → the
 * caller keeps it as `unsupported` + warn): the protocol gives the list
 * full-replacement semantics, and a half-parsed list would silently mislead
 * the autocomplete. Display-only `input.hint` degrades to null instead.
 */
export function toAvailableCommands(
  update: SessionUpdate & { sessionUpdate: 'available_commands_update' },
): AcpAvailableCommand[] | null {
  const list = (update as { availableCommands?: unknown }).availableCommands;
  if (!Array.isArray(list)) return null;
  const commands: AcpAvailableCommand[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { name, description, input } = entry as {
      name?: unknown;
      description?: unknown;
      input?: unknown;
    };
    if (typeof name !== 'string' || typeof description !== 'string') return null;
    let inputHint: string | null = null;
    if (input !== null && input !== undefined) {
      if (typeof input !== 'object') return null;
      const hint = (input as { hint?: unknown }).hint;
      if (typeof hint === 'string') inputHint = hint;
    }
    commands.push({ name, description, inputHint });
  }
  return commands;
}

/**
 * Whitelists a wire `configOptions` list (notification payload or
 * session/new · session/load · set_config_option result) into the UI model.
 * Structural violations (non-array list, non-object entry, missing or
 * wrongly-typed required fields) reject the whole list (null → the caller
 * keeps it as unsupported/absent + warn): full-replacement semantics means a
 * half-parsed list would render settings that no longer match the agent.
 * An entry whose `type` is unrecognized is skipped alone (spec: ignore that
 * option), so one future/vendor entry cannot blank the rest of the panel.
 * Select option groups flatten into per-choice `group` labels; a choice's
 * non-string `description` degrades to null (display-only).
 */
export function toConfigOptions(list: unknown): AcpConfigOption[] | null {
  if (!Array.isArray(list)) return null;
  const options: AcpConfigOption[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { id, name, description, category, type, currentValue, options: selectOptions } = entry as {
      id?: unknown;
      name?: unknown;
      description?: unknown;
      category?: unknown;
      type?: unknown;
      currentValue?: unknown;
      options?: unknown;
    };
    if (typeof id !== 'string' || typeof name !== 'string') return null;
    const desc = description === undefined || description === null ? null : description;
    if (desc !== null && typeof desc !== 'string') return null;
    const cat = category === undefined || category === null ? null : category;
    if (cat !== null && typeof cat !== 'string') return null;
    if (type === 'select') {
      if (typeof currentValue !== 'string') return null;
      const choices = flattenSelectOptions(selectOptions);
      if (choices === null) return null;
      options.push({ type: 'select', id, name, description: desc, category: cat, currentValue, choices });
    } else if (type === 'boolean') {
      if (typeof currentValue !== 'boolean') return null;
      options.push({ type: 'boolean', id, name, description: desc, category: cat, currentValue });
    } else {
      // Unknown/future/vendor option types have no control to render — the
      // spec says to ignore just that option (the agent keeps its default
      // for it), so one exotic entry must not blank the whole panel.
      warn(`config option ${id} has unknown type ${String(type)} — option ignored`);
      continue;
    }
  }
  return options;
}

/** Flat `[{value,name,description}]` or grouped `[{group,name,options:[…]}]` → flat choices with group labels. */
function flattenSelectOptions(wire: unknown): AcpConfigChoice[] | null {
  if (!Array.isArray(wire)) return null;
  const grouped = wire.length > 0 && wire.every((item) => typeof item === 'object' && item !== null && 'options' in item);
  const choices: AcpConfigChoice[] = [];
  if (grouped) {
    for (const group of wire as { group?: unknown; name?: unknown; options?: unknown }[]) {
      // Local binding keeps the string narrowing inside the map callback
      // (property narrowing does not survive into closures).
      const groupName = group.name;
      if (typeof groupName !== 'string') return null;
      const inner = flattenSelectOptions(group.options);
      if (inner === null) return null;
      choices.push(...inner.map((choice) => ({ ...choice, group: groupName })));
    }
    return choices;
  }
  for (const choice of wire) {
    if (typeof choice !== 'object' || choice === null) return null;
    const { value, name, description } = choice as { value?: unknown; name?: unknown; description?: unknown };
    if (typeof value !== 'string' || typeof name !== 'string') return null;
    const desc = description === undefined || description === null ? null : description;
    if (desc !== null && typeof desc !== 'string') return null;
    choices.push({ value, name, description: desc, group: null });
  }
  return choices;
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

/**
 * The schema union's closed branches. `ElicitationPropertySchema` also has
 * an open "future/vendor type" branch (`[key: string]: unknown`) that types
 * every field access as unknown — here we consume the known branches only;
 * anything else lands in the `unsupported` field below. Same for the
 * multiselect item schema (`StringMultiSelectItems | TitledMultiSelectItems`
 * carry the choices; other item types have none).
 */
type KnownElicitationProperty =
  | (StringPropertySchema & { type: 'string' })
  | (NumberPropertySchema & { type: 'number' })
  | (IntegerPropertySchema & { type: 'integer' })
  | (BooleanPropertySchema & { type: 'boolean' })
  | (MultiSelectPropertySchema & { type: 'array' });

/**
 * Whitelists an `elicitation/create` request (form mode) into the UI card
 * model. The wire schema restricts properties to primitives — each maps to
 * exactly one field variant; anything else (future/vendor types) becomes an
 * explicit `unsupported` field so the form shows it instead of losing it.
 */
export function toElicitationFormRequest(
  id: string,
  params: CreateElicitationRequest,
): Extract<ElicitationRequest, { mode: 'form' }> {
  // Caller-checked form mode; the cast strips the url/unknown-mode branches
  // the wire union keeps (requestedSchema lives on the form branch only).
  // `?? {}` guards a spec-violating form request without one.
  const schema = (params as ElicitationFormMode).requestedSchema ?? {};
  const required = new Set(schema.required ?? []);
  const fields: AcpElicitationField[] = Object.entries(schema.properties ?? {}).map(
    ([key, raw]) => {
      const property = raw as KnownElicitationProperty;
      const title = property.title ?? key;
      const description = property.description ?? undefined;
      if (property.type === 'string') {
        const options = oneOfOptions(property) ?? enumOptions(property);
        return {
          key,
          type: 'string' as const,
          title,
          ...(description ? { description } : {}),
          required: required.has(key),
          options,
          default: property.default ?? undefined,
        };
      }
      if (property.type === 'number' || property.type === 'integer') {
        return {
          key,
          type: property.type,
          title,
          ...(description ? { description } : {}),
          required: required.has(key),
          default: property.default ?? undefined,
        };
      }
      if (property.type === 'boolean') {
        return {
          key,
          type: 'boolean' as const,
          title,
          ...(description ? { description } : {}),
          required: required.has(key),
          default: property.default ?? undefined,
        };
      }
      if (property.type === 'array') {
        return {
          key,
          type: 'multiselect' as const,
          title,
          ...(description ? { description } : {}),
          required: required.has(key),
          options: multiSelectOptions(property),
          default: property.default ?? undefined,
        };
      }
      // Unreachable per the cast's closed union — kept as the runtime guard
      // for the vendor/future property types the cast stripped; read the
      // type off the raw wire value (property is `never` here).
      const propertyType = String((raw as { type?: unknown }).type ?? 'unknown');
      warn(`elicitation property "${key}" has unsupported type "${propertyType}" — rendered inert`);
      return { key, type: 'unsupported', title, required: false, propertyType };
    },
  );
  // Only the session scope carries a toolCallId; request-scoped elicitations
  // (pre-session) and session-scoped alike resolve to null when absent.
  const toolCallId =
    'toolCallId' in params && typeof params.toolCallId === 'string' ? params.toolCallId : null;
  return {
    mode: 'form',
    id,
    toolCallId,
    title: schema.title ?? null,
    description: schema.description ?? null,
    fields,
  };
}

/**
 * Whitelists an `elicitation/create` request (url mode) into the UI card
 * model. The wire `elicitationId` becomes the record id unchanged — the
 * later `elicitation/complete` notification matches on it, and the spec
 * says to treat it as opaque. No schema to whitelist here; the card shows
 * the message and the full URL and lets consent do the rest.
 */
export function toElicitationUrlRequest(
  params: CreateElicitationRequest,
): Extract<ElicitationRequest, { mode: 'url' }> {
  // Caller-checked url mode; the cast strips the form/unknown-mode branches
  // the wire union keeps (elicitationId and url live on the url branch only).
  const urlMode = params as ElicitationUrlMode;
  const toolCallId =
    'toolCallId' in params && typeof params.toolCallId === 'string' ? params.toolCallId : null;
  return {
    mode: 'url',
    id: urlMode.elicitationId,
    toolCallId,
    message: params.message,
    url: urlMode.url,
  };
}

/** Titled single-select choices (`oneOf` wins over bare `enum`). */
function oneOfOptions(property: StringPropertySchema): AcpElicitationOption[] | null {
  if (!property.oneOf || property.oneOf.length === 0) return null;
  return property.oneOf.map((option) => ({ value: option.const, label: option.title ?? option.const }));
}

function enumOptions(property: StringPropertySchema): AcpElicitationOption[] | null {
  if (!property.enum || property.enum.length === 0) return null;
  return property.enum.map((value) => ({ value, label: value }));
}

function multiSelectOptions(property: MultiSelectPropertySchema): AcpElicitationOption[] {
  const items = property.items as StringMultiSelectItems | TitledMultiSelectItems;
  if ('anyOf' in items && items.anyOf.length > 0) {
    return items.anyOf.map((option) => ({ value: option.const, label: option.title ?? option.const }));
  }
  if ('enum' in items && items.enum.length > 0) {
    return items.enum.map((value) => ({ value, label: value }));
  }
  warn('elicitation multiselect without choices — rendered as an empty group');
  return [];
}

/**
 * Whitelists a `session/new` · `session/load` result's mode state into the
 * protocol-layer type (drops the wire `_meta` bag). null passes through as
 * null — "no modes" is a state, not an error.
 */
export function toSessionModeState(
  modes: { currentModeId: string; availableModes: Array<{ id: string; name: string; description?: string | null | undefined }> } | null | undefined,
): AcpSessionModeState | null {
  if (!modes) return null;
  return {
    currentModeId: modes.currentModeId,
    availableModes: modes.availableModes.map((mode) => ({
      id: mode.id,
      name: mode.name,
      ...(mode.description ? { description: mode.description } : {}),
    })),
  };
}
