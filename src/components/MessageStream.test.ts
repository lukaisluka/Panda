import { describe, expect, it } from 'vitest';
import { flatten } from './MessageStream';
import type {
  PermissionRequest,
  SessionDocument,
  SessionNotification,
  ToolCallState,
} from '../protocol/types';
import type { AttachedPermission } from './PermissionCard';

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

const pending = (request: PermissionRequest): AttachedPermission => ({
  state: 'pending',
  request,
});

const denied = (request: PermissionRequest): AttachedPermission => ({
  state: 'denied',
  request,
  response: { outcome: 'denied-by-policy', kind: 'reject_once' },
});

function toolCall(id: string, status: ToolCallState['status'] = 'pending'): ToolCallState {
  return { id, title: id, kind: 'other', status, content: [], locations: [] };
}

function documentWith(...calls: ToolCallState[]): SessionDocument {
  return {
    turns: [{ id: 'turn-1', blocks: calls.map((call) => ({ kind: 'tool_call' as const, call })) }],
    status: 'requires_action',
    usage: { used: 0, size: 0, cost: null },
    permissions: {},
    latestNotifications: {},
    unhandledNotifications: [],
  };
}

describe('flatten permission placement', () => {
  it('mounts a permission card on the exact matching tool call', () => {
    const items = flatten(documentWith(toolCall('permission-id')), [pending(permission)], null);

    expect(items[0]).toMatchObject({ kind: 'block', permission: pending(permission) });
  });

  it('mounts an unmatched permission on the sole pending tool call in the current turn', () => {
    const items = flatten(documentWith(toolCall('stream-id')), [pending(permission)], null);

    expect(items[0]).toMatchObject({ kind: 'block', permission: pending(permission) });
  });

  it('renders an unmatched permission independently when multiple pending calls make attachment ambiguous', () => {
    const items = flatten(
      documentWith(toolCall('first-pending'), toolCall('second-pending')),
      [pending(permission)],
      null,
    );

    expect(items).toHaveLength(3);
    expect(items[2]).toMatchObject({ kind: 'permission', permission: pending(permission) });
  });

  it('renders several pending permissions concurrently, each answered independently (issue #18)', () => {
    const items = flatten(
      documentWith(toolCall('permission-id'), toolCall('second-permission-id')),
      [pending(permission), pending(secondPermission)],
      null,
    );

    // Both cards attach to their own tool call — no first-wins cancellation.
    expect(items[0]).toMatchObject({ kind: 'block', permission: pending(permission) });
    expect(items[1]).toMatchObject({ kind: 'block', permission: pending(secondPermission) });
  });

  it('renders unmatched concurrent permissions as stacked independent cards', () => {
    const items = flatten(
      documentWith(toolCall('first-pending'), toolCall('second-pending')),
      [pending(permission), pending(secondPermission)],
      null,
    );

    expect(items).toHaveLength(4);
    expect(items[2]).toMatchObject({ kind: 'permission', permission: pending(permission) });
    expect(items[3]).toMatchObject({ kind: 'permission', permission: pending(secondPermission) });
  });

  it('never evicts a mounted permission — an unmatched one degrades to an independent card', () => {
    // The exact match claims the tool call; the second permission's
    // sole-pending-call fallback would land on the same block.
    const items = flatten(
      documentWith(toolCall('permission-id')),
      [pending(permission), pending(secondPermission)],
      null,
    );

    expect(items[0]).toMatchObject({ kind: 'block', permission: pending(permission) });
    expect(items[1]).toMatchObject({ kind: 'permission', permission: pending(secondPermission) });
  });

  it('attaches a policy-denied record to its exact tool call (issue #22)', () => {
    // The denied tool retired to cancelled status — exact-match attachment
    // must still find it by id (the fallback heuristic must not claim it).
    const items = flatten(
      documentWith(toolCall('permission-id', 'cancelled')),
      [denied(permission)],
      null,
    );

    expect(items[0]).toMatchObject({ kind: 'block', permission: denied(permission) });
  });

  it('renders a policy-denied record independently when its tool call is absent', () => {
    const items = flatten(documentWith(toolCall('other-call', 'in_progress')), [denied(permission)], null);

    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ kind: 'permission', permission: denied(permission) });
    // Standalone keys disambiguate by state: a re-ask after a deny can ping-pong
    // the same toolCallId between pending and denied records.
    expect(items[1]!.key).toBe('denied-permission-id');
  });
});

describe('flatten unsupported fallback blocks', () => {
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
      permissions: {},
      latestNotifications: {},
      unhandledNotifications: [notification],
    };

    const items = flatten(doc, [], null);
    expect(items.map((item) => (item.kind === 'block' ? item.block.kind : item.kind))).toEqual([
      'user_message',
      'unsupported',
      'agent_message',
    ]);
  });
});
