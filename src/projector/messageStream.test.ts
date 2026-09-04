import { describe, expect, it } from 'vitest';
import { projectMessageStream } from './messageStream';
import type { FlatItem } from './messageStream';
import { applyUpdate, emptySession } from '../protocol/reducer';
import type {
  PermissionRequest,
  PermissionState,
  SessionDocument,
  SessionNotification,
  ToolCallState,
} from '../protocol/types';

const permission: PermissionRequest = {
  toolCallId: 'permission-id',
  title: 'Approve the operation',
  options: [{ id: 'approve', name: 'Approve', kind: 'allow_once' }],
};

const secondPermission: PermissionRequest = {
  toolCallId: 'second-permission-id',
  title: 'Approve the other operation',
  options: [{ id: 'approve', name: 'Approve', kind: 'allow_once' }],
};

function pendingState(request: PermissionRequest): PermissionState {
  return { status: 'pending', request, response: null };
}

function deniedState(request: PermissionRequest): PermissionState {
  return { status: 'resolved', request, response: { outcome: 'denied-by-policy', kind: 'reject_once' } };
}

function toolCall(id: string, status: ToolCallState['status'] = 'pending'): ToolCallState {
  return { id, title: id, kind: 'other', status, content: [], locations: [] };
}

function documentWith(...calls: ToolCallState[]): SessionDocument {
  return {
    turns: [{ id: 'turn-1', blocks: calls.map((call) => ({ kind: 'tool_call' as const, call })) }],
    status: 'requires_action',
    usage: { used: 0, size: 0, cost: null },
    plan: null,
    modes: null,
    availableCommands: [],
    configOptions: null,
    permissions: {},
    elicitations: {},
    latestNotifications: {},
    unhandledNotifications: [],
  };
}

/** Splices permission states into a document's record, keyed by toolCallId. */
function withPermissions(doc: SessionDocument, ...states: PermissionState[]): SessionDocument {
  return {
    ...doc,
    permissions: Object.fromEntries(states.map((state) => [state.request.toolCallId, state])),
  };
}

function blockItem(item: FlatItem) {
  if (item.kind !== 'block') throw new Error(`expected block item, got ${item.kind}`);
  return item;
}

describe('projection permission placement', () => {
  it('mounts a permission card on the exact matching tool call', () => {
    const items = projectMessageStream(
      withPermissions(documentWith(toolCall('permission-id')), pendingState(permission)),
    );

    expect(items[0]).toMatchObject({
      kind: 'block',
      permission: { state: 'pending', request: permission },
    });
  });

  it('mounts an unmatched permission on the sole pending tool call in the current turn', () => {
    const items = projectMessageStream(
      withPermissions(documentWith(toolCall('stream-id')), pendingState(permission)),
    );

    expect(items[0]).toMatchObject({
      kind: 'block',
      permission: { state: 'pending', request: permission },
    });
  });

  it('renders an unmatched permission independently when multiple pending calls make attachment ambiguous', () => {
    const items = projectMessageStream(
      withPermissions(
        documentWith(toolCall('first-pending'), toolCall('second-pending')),
        pendingState(permission),
      ),
    );

    expect(items).toHaveLength(3);
    expect(items[2]).toMatchObject({
      kind: 'permission',
      permission: { state: 'pending', request: permission },
    });
  });

  it('renders several pending permissions concurrently, each answered independently (issue #18)', () => {
    const items = projectMessageStream(
      withPermissions(
        documentWith(toolCall('permission-id'), toolCall('second-permission-id')),
        pendingState(permission),
        pendingState(secondPermission),
      ),
    );

    // Both cards attach to their own tool call — no first-wins cancellation.
    expect(items[0]).toMatchObject({
      kind: 'block',
      permission: { state: 'pending', request: permission },
    });
    expect(items[1]).toMatchObject({
      kind: 'block',
      permission: { state: 'pending', request: secondPermission },
    });
  });

  it('renders unmatched concurrent permissions as stacked independent cards', () => {
    const items = projectMessageStream(
      withPermissions(
        documentWith(toolCall('first-pending'), toolCall('second-pending')),
        pendingState(permission),
        pendingState(secondPermission),
      ),
    );

    expect(items).toHaveLength(4);
    expect(items[2]).toMatchObject({
      kind: 'permission',
      permission: { state: 'pending', request: permission },
    });
    expect(items[3]).toMatchObject({
      kind: 'permission',
      permission: { state: 'pending', request: secondPermission },
    });
  });

  it('never evicts a mounted permission — an unmatched one degrades to an independent card', () => {
    // The exact match claims the tool call; the second permission's
    // sole-pending-call fallback would land on the same block.
    const items = projectMessageStream(
      withPermissions(
        documentWith(toolCall('permission-id')),
        pendingState(permission),
        pendingState(secondPermission),
      ),
    );

    expect(items[0]).toMatchObject({
      kind: 'block',
      permission: { state: 'pending', request: permission },
    });
    expect(items[1]).toMatchObject({
      kind: 'permission',
      permission: { state: 'pending', request: secondPermission },
    });
  });

  it('attaches a policy-denied record to its exact tool call (issue #22)', () => {
    // The denied tool retired to cancelled status — exact-match attachment
    // must still find it by id (the fallback heuristic must not claim it).
    const items = projectMessageStream(
      withPermissions(documentWith(toolCall('permission-id', 'cancelled')), deniedState(permission)),
    );

    expect(items[0]).toMatchObject({
      kind: 'block',
      permission: { state: 'denied', request: permission },
    });
  });

  it('renders a policy-denied record independently when its tool call is absent', () => {
    const items = projectMessageStream(
      withPermissions(documentWith(toolCall('other-call', 'in_progress')), deniedState(permission)),
    );

    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({
      kind: 'permission',
      permission: { state: 'denied', request: permission },
    });
    // Standalone keys disambiguate by state: a re-ask after a deny can ping-pong
    // the same toolCallId between pending and denied records.
    expect(items[1]!.key).toBe('denied-permission-id');
  });
});

describe('projection unsupported fallback blocks', () => {
  it('keeps unsupported blocks in flow order between rendered blocks', () => {
    const notification = {
      sessionId: 's-1',
      update: { sessionUpdate: 'vendor_extension', payload: { x: 1 } },
    } as unknown as SessionNotification;
    const doc: SessionDocument = {
      turns: [
        {
          id: 'turn-1',
          blocks: [
            { kind: 'user_message', content: [{ type: 'text', text: 'hi' }] },
            { kind: 'unsupported', notification },
            { kind: 'agent_message', messageId: 'm-1', parts: [{ type: 'text', text: 'hey' }] },
          ],
        },
      ],
      status: 'idle',
      usage: { used: 0, size: 0, cost: null },
      plan: null,
      modes: null,
      availableCommands: [],
      configOptions: null,
      permissions: {},
      elicitations: {},
      latestNotifications: {},
      unhandledNotifications: [notification],
    };

    const items = projectMessageStream(doc);
    expect(items.map((item) => (item.kind === 'block' ? item.block.kind : item.kind))).toEqual([
      'user_message',
      'unsupported',
      'agent_message',
    ]);
  });
});

describe('projection identity stability (ADR 0006)', () => {
  const toolPermission: PermissionRequest = {
    toolCallId: 't-1',
    title: 'Approve the operation',
    options: [{ id: 'approve', name: 'Approve', kind: 'allow_once' }],
  };

  /** turn-1: [user, agent m-1, tool t-1 (+pending permission), agent m-2]. */
  function seed(): SessionDocument {
    let doc = emptySession();
    doc = applyUpdate(doc, { sessionUpdate: 'user_message', content: [{ type: 'text', text: 'hi' }] });
    doc = applyUpdate(doc, {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm-1',
      content: { type: 'text', text: 'hello' },
    });
    doc = applyUpdate(doc, { sessionUpdate: 'tool_call', toolCallId: 't-1', title: 'Read file', status: 'in_progress' });
    doc = applyUpdate(doc, { sessionUpdate: 'permission_requested', request: toolPermission });
    return applyUpdate(doc, {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm-2',
      content: { type: 'text', text: 'result' },
    });
  }

  it('returns the identical array for the identical document', () => {
    const doc = seed();
    expect(projectMessageStream(doc)).toBe(projectMessageStream(doc));
  });

  it('keeps untouched item identities across a streamed chunk', () => {
    const doc = seed();
    const before = projectMessageStream(doc);
    const chunked = applyUpdate(doc, {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm-2',
      content: { type: 'text', text: ' more' },
    });
    const after = projectMessageStream(chunked);

    expect(after[0]).toBe(before[0]); // user block
    expect(after[1]).toBe(before[1]); // earlier agent message
    expect(after[2]).toBe(before[2]); // tool call with its attached permission card
    expect(after[3]).not.toBe(before[3]); // the streamed message itself changed
    expect(blockItem(after[3]!).block).not.toBe(blockItem(before[3]!).block);
  });

  it('keeps every item identity across a usage update (no turn churn)', () => {
    const doc = seed();
    const before = projectMessageStream(doc);
    const after = projectMessageStream(
      applyUpdate(doc, { sessionUpdate: 'usage_update', used: 5, size: 100 }),
    );

    expect(after).not.toBe(before); // a new document yields a new list…
    after.forEach((item, i) => expect(item).toBe(before[i])); // …of the same items
  });

  it('rebuilds only the affected tool item when an unrelated permission settles', () => {
    let doc = emptySession();
    doc = applyUpdate(doc, { sessionUpdate: 'user_message', content: [{ type: 'text', text: 'hi' }] });
    doc = applyUpdate(doc, { sessionUpdate: 'tool_call', toolCallId: 't-1', title: 'A', status: 'in_progress' });
    doc = applyUpdate(doc, { sessionUpdate: 'tool_call', toolCallId: 't-2', title: 'B', status: 'in_progress' });
    doc = applyUpdate(doc, { sessionUpdate: 'permission_requested', request: { ...toolPermission, toolCallId: 't-1' } });
    doc = applyUpdate(doc, {
      sessionUpdate: 'permission_requested',
      request: { ...toolPermission, toolCallId: 't-2' },
    });
    const before = projectMessageStream(doc);
    const settled = applyUpdate(doc, {
      sessionUpdate: 'permission_resolved',
      toolCallId: 't-2',
      response: { outcome: 'selected', kind: 'allow_once' },
    });
    const after = projectMessageStream(settled);

    expect(after[0]).toBe(before[0]); // user block
    expect(after[1]).toBe(before[1]); // t-1 keeps its pending card
    expect(after[2]).not.toBe(before[2]); // t-2 lost its card — its item changed
    expect(blockItem(after[2]!).permission).toBeNull();
  });

  it('flips streaming on only the trailing agent message when the turn runs', () => {
    const doc = seed();
    const idle = projectMessageStream(doc);
    const running = projectMessageStream({ ...doc, status: 'running' });

    expect(running[0]).toBe(idle[0]);
    expect(blockItem(running[3]!).streaming).toBe(true);
    expect(blockItem(idle[3]!).streaming).toBe(false);
    expect(running[3]).not.toBe(idle[3]); // the streaming flag is part of the item
  });

  it('streams a trailing thought while running and settles it once a block follows', () => {
    // The thought is the very last block of a running turn → live (Thinking
    // label + tail preview).
    let doc = applyUpdate(
      applyUpdate(emptySession(), {
        sessionUpdate: 'user_message',
        content: [{ type: 'text', text: 'go' }],
      }),
      { sessionUpdate: 'agent_thought_chunk', messageId: 'th-1', content: { type: 'text', text: 'analyzing…' } },
    );
    doc = { ...doc, status: 'running' };
    expect(blockItem(projectMessageStream(doc)[1]!).streaming).toBe(true);

    // Any later block (a tool call here) settles the thought — its label
    // must flip to Thought even though the turn is still running.
    doc = applyUpdate(doc, { sessionUpdate: 'tool_call', toolCallId: 't-9', title: 'Run', kind: 'execute' });
    const settled = projectMessageStream(doc);
    expect(blockItem(settled[1]!).streaming).toBe(false);
  });

  it('yields equal output for structurally equal input (fresh identities, no cache)', () => {
    const doc = seed();
    expect(projectMessageStream(structuredClone(doc))).toEqual(projectMessageStream(doc));
  });
});
