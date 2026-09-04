import { describe, expect, it } from 'vitest';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { alwaysAskPolicy, denyResolution, type PermissionPolicy } from './policy';

function request(options: Array<{ optionId: string; kind: RequestPermissionRequest['options'][number]['kind'] }>): RequestPermissionRequest {
  return {
    sessionId: 's-1',
    toolCall: { toolCallId: 'edit-1', title: 'Edit file', kind: 'edit', status: 'pending' },
    options: options.map((option, i) => ({ optionId: option.optionId, name: `Option ${i}`, kind: option.kind })),
  } as RequestPermissionRequest;
}

const fullOffer = [
  { optionId: 'allow-once', kind: 'allow_once' },
  { optionId: 'allow-always', kind: 'allow_always' },
  { optionId: 'reject-once', kind: 'reject_once' },
  { optionId: 'reject-always', kind: 'reject_always' },
] as const;

describe('alwaysAskPolicy (issue #22)', () => {
  it('任何请求都返回 ask——默认永远是用户决定', () => {
    const verdict = alwaysAskPolicy(request([...fullOffer]), { connectionId: 'c-1', url: 'ws://x' });
    expect(verdict).toBe('ask');
  });
});

describe('denyResolution', () => {
  it('优先选 reject_once', () => {
    const { wire, ui } = denyResolution(fullOffer.map((o) => ({ ...o })));
    expect(wire).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
    expect(ui).toEqual({ outcome: 'denied-by-policy', kind: 'reject_once' });
  });

  it('没有 reject_once 时退到 reject_always', () => {
    const { wire, ui } = denyResolution([
      { optionId: 'allow-once', kind: 'allow_once' },
      { optionId: 'reject-always', kind: 'reject_always' },
    ]);
    expect(wire).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-always' } });
    expect(ui).toEqual({ outcome: 'denied-by-policy', kind: 'reject_always' });
  });

  it('agent 未提供任何拒绝选项 → cancelled——绝不选 allow 选项', () => {
    const { wire, ui } = denyResolution([
      { optionId: 'allow-once', kind: 'allow_once' },
      { optionId: 'allow-always', kind: 'allow_always' },
    ]);
    expect(wire).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(ui).toEqual({ outcome: 'denied-by-policy', kind: null });
  });
});

describe('PermissionPolicy 类型契约', () => {
  it('判定值只能是 ask 或 deny（编译期约束，运行期冒烟）', () => {
    const denyAll: PermissionPolicy = () => 'deny';
    expect(denyAll(request([...fullOffer]), { connectionId: 'direct:x', url: null })).toBe('deny');
  });
});
