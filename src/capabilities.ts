/**
 * Effective capability composition (issue #22, ADR 0004): the single decision
 * point every consumer — UI gating and execution paths alike — must go
 * through. Raw agent declarations (`initialize`) stay where they are; what
 * changes is that nobody gates on them directly anymore.
 *
 *   Agent Capabilities (initialize 声明)
 *           ×
 *   Host Capabilities (v2-anchored shards, by existence)
 *           ×
 *   Policy (capability-level placeholder — reserved, not produced in MVP)
 *           ↓
 *   Effective Capability (available + reason)
 *
 * The module is pure on purpose: no store imports, structural parameters —
 * it is the seam both the selectors and the ACP client consume.
 */

/** The capability keys Panda gates on (the v1 agent declarations). */
export type CapabilityKey = 'image' | 'loadSession' | 'list' | 'resume' | 'delete';

/** Agent-side declarations for every capability key. */
export type AgentCapabilityDeclarations = Record<CapabilityKey, boolean>;

/**
 * Host capability shards (ADR 0004): the client-side protocol surfaces
 * Panda's host can actually provide, expressed by existence. The vocabulary
 * is anchored to the ACP v2 surviving client methods — fs/terminal are
 * deliberately absent (v2 removes that execution surface; a future
 * file/exec exposure belongs to the `mcp` shard via a client MCP server).
 */
export type HostCapabilityShard = 'permission' | 'sessionUpdate' | 'mcp' | 'elicitation';

/** Host-side shard availability, by existence. */
export type HostCapabilities = Record<HostCapabilityShard, boolean>;

/**
 * The browser host today: Panda answers permissions, absorbs session
 * updates, and serves form-mode elicitation (`elicitation/create`, form);
 * client-side MCP and url-mode elicitation are not implemented yet. `false`
 * is a statement of fact ("the host lacks the shard"), not a configuration.
 */
export const PANDA_HOST_CAPABILITIES: HostCapabilities = {
  permission: true,
  sessionUpdate: true,
  mcp: false,
  elicitation: true,
};

/**
 * Which host shard each capability depends on, if any. All five v1 gates are
 * agent-declared session/prompt features with no host dependency; future
 * keys (client-side MCP, elicitation UI) declare theirs here.
 */
export const CAPABILITY_HOST_SHARDS: Record<CapabilityKey, HostCapabilityShard | null> = {
  image: null,
  loadSession: null,
  list: null,
  resume: null,
  delete: null,
};

/** Why a capability is unavailable — drives the UI's presentation choice. */
export type EffectiveCapabilityReason =
  | 'unsupported-by-agent'
  | 'unavailable-on-host'
  | 'blocked-by-policy';

export type EffectiveCapability = {
  available: boolean;
  reason: EffectiveCapabilityReason | null;
};

/**
 * Interned verdicts: every judgment returns one of these shared instances.
 * That makes composed maps shallow-stable, which the store's useShallow
 * selector for effective capabilities depends on — never mutate a verdict.
 */
const VERDICTS: { available: EffectiveCapability } & Record<EffectiveCapabilityReason, EffectiveCapability> = {
  available: { available: true, reason: null },
  'unsupported-by-agent': { available: false, reason: 'unsupported-by-agent' },
  'unavailable-on-host': { available: false, reason: 'unavailable-on-host' },
  'blocked-by-policy': { available: false, reason: 'blocked-by-policy' },
};

/**
 * Capability-level policy (issue #22): the third dimension of the
 * composition, reserved. The MVP passes nothing (the default admits every
 * capability); a future capability-level policy supplies per-key verdicts
 * and `blocked-by-policy` starts being produced.
 */
export type CapabilityPolicy = (key: CapabilityKey) => boolean;

/** Overridable composition inputs — the test seams for fake shards/policies. */
export type CapabilityComposition = {
  hostShards?: Record<CapabilityKey, HostCapabilityShard | null>;
  capabilityPolicy?: CapabilityPolicy;
};

/**
 * One capability's effective verdict. The order of the checks IS the
 * priority: an agent that never declared the capability answers first (the
 * status quo — hide), a missing host shard second (visible but
 * unavailable), policy last.
 */
export function effectiveCapability(
  key: CapabilityKey,
  agent: AgentCapabilityDeclarations,
  host: HostCapabilities,
  composition: CapabilityComposition = {},
): EffectiveCapability {
  if (!agent[key]) return VERDICTS['unsupported-by-agent'];
  const shard = (composition.hostShards ?? CAPABILITY_HOST_SHARDS)[key];
  if (shard !== null && !host[shard]) return VERDICTS['unavailable-on-host'];
  if (composition.capabilityPolicy && !composition.capabilityPolicy(key)) {
    return VERDICTS['blocked-by-policy'];
  }
  return VERDICTS.available;
}

/** Every capability's verdict in one call — for whole-slot UI gating. */
export function effectiveCapabilities(
  agent: AgentCapabilityDeclarations,
  host: HostCapabilities,
  composition: CapabilityComposition = {},
): Record<CapabilityKey, EffectiveCapability> {
  return {
    image: effectiveCapability('image', agent, host, composition),
    loadSession: effectiveCapability('loadSession', agent, host, composition),
    list: effectiveCapability('list', agent, host, composition),
    resume: effectiveCapability('resume', agent, host, composition),
    delete: effectiveCapability('delete', agent, host, composition),
  };
}
