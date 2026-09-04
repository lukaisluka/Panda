import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_HOST_SHARDS,
  PANDA_HOST_CAPABILITIES,
  effectiveCapabilities,
  effectiveCapability,
  type HostCapabilities,
} from './capabilities';

const declareAll = { image: true, loadSession: true, list: true, resume: true, delete: true };
const declareNone = { image: false, loadSession: false, list: false, resume: false, delete: false };

const allShards: HostCapabilities = {
  permission: true,
  sessionUpdate: true,
  mcp: true,
  elicitation: true,
};

describe('effectiveCapability (issue #22)', () => {
  it('agent 未声明 → unsupported-by-agent', () => {
    expect(effectiveCapability('image', declareNone, allShards)).toEqual({
      available: false,
      reason: 'unsupported-by-agent',
    });
  });

  it('agent 声明且宿主无依赖 → available（真实分片表）', () => {
    expect(effectiveCapability('loadSession', declareAll, PANDA_HOST_CAPABILITIES)).toEqual({
      available: true,
      reason: null,
    });
  });

  it('agent 声明 × 宿主缺失 → unavailable-on-host（验收标准 3，假分片）', () => {
    // image 本无宿主依赖；用可注入的分片表构造该组合
    const hostShards = { ...CAPABILITY_HOST_SHARDS, image: 'mcp' as const };
    expect(
      effectiveCapability('image', declareAll, { ...allShards, mcp: false }, { hostShards }),
    ).toEqual({ available: false, reason: 'unavailable-on-host' });
    // 同一假分片、宿主具备 → available：证明拦截来自宿主维度而非声明
    expect(effectiveCapability('image', declareAll, allShards, { hostShards })).toEqual({
      available: true,
      reason: null,
    });
  });

  it('agent 未声明优先于宿主缺失（检查顺序即优先级）', () => {
    const hostShards = { ...CAPABILITY_HOST_SHARDS, image: 'mcp' as const };
    expect(
      effectiveCapability('image', declareNone, { ...allShards, mcp: false }, { hostShards }),
    ).toEqual({ available: false, reason: 'unsupported-by-agent' });
  });

  it('能力级策略拒绝 → blocked-by-policy（预留维度，MVP 不产生）', () => {
    expect(
      effectiveCapability('image', declareAll, allShards, { capabilityPolicy: () => false }),
    ).toEqual({ available: false, reason: 'blocked-by-policy' });
  });

  it('PANDA_HOST_CAPABILITIES：permission/sessionUpdate 在场，mcp/elicitation 缺席', () => {
    expect(PANDA_HOST_CAPABILITIES).toEqual({
      permission: true,
      sessionUpdate: true,
      mcp: false,
      elicitation: false,
    });
  });

  it('现有五项能力均无宿主分片依赖', () => {
    expect(Object.values(CAPABILITY_HOST_SHARDS)).toEqual([null, null, null, null, null]);
  });

  it('判定对象 intern：同 verdict 恒等——useShallow 选择器的稳定性契约', () => {
    expect(effectiveCapability('image', declareAll, allShards)).toBe(
      effectiveCapability('loadSession', declareAll, allShards),
    );
    expect(effectiveCapability('image', declareNone, allShards)).toBe(
      effectiveCapability('loadSession', declareNone, allShards),
    );
  });
});

describe('effectiveCapabilities', () => {
  it('maps every capability key', () => {
    const all = effectiveCapabilities(declareAll, allShards);
    expect(Object.keys(all).sort()).toEqual(['delete', 'image', 'list', 'loadSession', 'resume']);
    expect(Object.values(all).every((verdict) => verdict.available)).toBe(true);
  });
});
