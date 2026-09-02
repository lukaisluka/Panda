import { describe, expect, it } from 'vitest';
import { flatten } from './MessageStream';
import type { PermissionRequest, SessionDocument, ToolCallState } from '../protocol/types';

const permission: PermissionRequest = {
  toolCallId: 'permission-id',
  title: 'Approve the operation',
  options: [{ id: 'approve', name: 'Approve', kind: 'allow_once' }],
};

function toolCall(id: string, status: ToolCallState['status'] = 'pending'): ToolCallState {
  return { id, title: id, kind: 'other', status, content: [], locations: [] };
}

function documentWith(...calls: ToolCallState[]): SessionDocument {
  return {
    turns: [{ id: 'turn-1', blocks: calls.map((call) => ({ kind: 'tool_call' as const, call })) }],
    status: 'requires_action',
    usage: { used: 0, size: 0, cost: null },
  };
}

describe('flatten permission placement', () => {
  it('mounts a permission card on the exact matching tool call', () => {
    const items = flatten(documentWith(toolCall('permission-id')), permission, null);

    expect(items[0]).toMatchObject({ kind: 'block', permission });
  });

  it('mounts an unmatched permission on the sole pending tool call in the current turn', () => {
    const items = flatten(documentWith(toolCall('stream-id')), permission, null);

    expect(items[0]).toMatchObject({ kind: 'block', permission });
  });

  it('renders an unmatched permission independently when multiple pending calls make attachment ambiguous', () => {
    const items = flatten(
      documentWith(toolCall('first-pending'), toolCall('second-pending')),
      permission,
      null,
    );

    expect(items).toHaveLength(3);
    expect(items[2]).toMatchObject({ kind: 'permission', request: permission });
  });
});
