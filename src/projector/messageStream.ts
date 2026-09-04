/**
 * Message-stream projection (issue #24, ADR 0006): folds the session document
 * into the flat item list the virtualized stream renders.
 *
 * Pure in behavior — the same document always yields the same output — but
 * memoized so unchanged items keep their wrapper identities across documents
 * that share structure. The caches are keyed on the objects the reducer
 * preserves (blocks, permission records), mirroring its structural sharing:
 * the reducer guarantees untouched block identities, this layer guarantees the
 * wrappers riding on them do not churn either. That handshake is what the
 * memoized block views and the virtualized list lean on.
 *
 * Permission placement is a faithful port of the component-era flatten/attach
 * logic: exact toolCallId match claims a block (first match wins, one
 * permission per block — a second degrades instead of evicting), else the
 * current turn's sole pending call, else an independent trailing card.
 */

import type {
  Block,
  DeniedPermissionResponse,
  ElicitationRequest,
  ElicitationResponse,
  ElicitationState,
  PermissionRequest,
  PermissionState,
  SessionDocument,
} from '../protocol/types';

/**
 * A permission as the message flow attaches it to a tool call (or renders it
 * as an independent card): pending waits for the user; denied settled by host
 * policy (issue #22). Minted by this projection with identity-stable wrappers.
 */
export type AttachedPermission =
  | { state: 'pending'; request: PermissionRequest }
  | { state: 'denied'; request: PermissionRequest; response: DeniedPermissionResponse };

export type BlockFlatItem = {
  key: string;
  kind: 'block';
  block: Block;
  streaming: boolean;
  permission: AttachedPermission | null;
};

export type StandalonePermissionItem = {
  key: string;
  kind: 'permission';
  permission: AttachedPermission;
};

/**
 * An elicitation as the flow renders it: always an independent trailing
 * card (never attached to a tool call — a form stands on its own). Pending
 * is the form; settled keeps a one-line terminal record.
 */
export type AttachedElicitation =
  | { state: 'pending'; request: ElicitationRequest }
  | { state: 'settled'; request: ElicitationRequest; response: ElicitationResponse };

export type StandaloneElicitationItem = {
  key: string;
  kind: 'elicitation';
  elicitation: AttachedElicitation;
};

export type FlatItem = BlockFlatItem | StandalonePermissionItem | StandaloneElicitationItem;

// Identity-stable wrappers. All WeakMaps: keys are session-owned objects, so
// caches are scoped per session graph and collected with it. The base variant
// (no streaming, no permission) has its own cache — passes below request the
// base first and the attached variant later, so a single-slot cache would
// thrash between the two on every projection.
const docItemsCache = new WeakMap<SessionDocument, FlatItem[]>();
const attachedCache = new WeakMap<PermissionState, AttachedPermission>();
const attachedListCache = new WeakMap<Record<string, PermissionState>, AttachedPermission[]>();
const baseItemCache = new WeakMap<Block, BlockFlatItem>();
/** One cached non-base variant per block: the (streaming, permission) combination it was last built for. */
const variantItemCache = new WeakMap<
  Block,
  { streaming: boolean; permission: AttachedPermission | null; item: BlockFlatItem }
>();
const standaloneItemCache = new WeakMap<AttachedPermission, StandalonePermissionItem>();
const attachedElicitationCache = new WeakMap<ElicitationState, AttachedElicitation>();
const attachedElicitationListCache = new WeakMap<Record<string, ElicitationState>, AttachedElicitation[]>();
const standaloneElicitationItemCache = new WeakMap<AttachedElicitation, StandaloneElicitationItem>();

export function projectMessageStream(doc: SessionDocument): FlatItem[] {
  const cached = docItemsCache.get(doc);
  if (cached) return cached;

  const permissions = attachedPermissions(doc.permissions);
  const streamingBlock = findStreamingBlock(doc);

  // Pass 1: block items in flow order; permission fields still empty.
  const blocks: Block[] = [];
  const blockItems: BlockFlatItem[] = [];
  for (const turn of doc.turns) {
    turn.blocks.forEach((block, i) => {
      blocks.push(block);
      blockItems.push(blockItem(`${turn.id}-${i}`, block, block === streamingBlock, null));
    });
  }

  // Pass 2: permission placement against parallel claim state — placement
  // never mutates cached wrappers, claimed blocks swap variants in pass 3.
  const placed: (AttachedPermission | null)[] = blockItems.map(() => null);
  const standalone: AttachedPermission[] = [];
  const lastTurn = doc.turns.at(-1);
  const pendingCalls =
    lastTurn?.blocks.filter(
      (block): block is Extract<Block, { kind: 'tool_call' }> =>
        block.kind === 'tool_call' && block.call.status === 'pending',
    ) ?? [];
  const fallbackBlock = pendingCalls.length === 1 ? pendingCalls[0] : undefined;

  for (const permission of permissions) {
    const exactIndex = blocks.findIndex(
      (block) => block.kind === 'tool_call' && block.call.id === permission.request.toolCallId,
    );
    if (exactIndex >= 0 && placed[exactIndex] === null) {
      placed[exactIndex] = permission;
      continue;
    }
    if (fallbackBlock) {
      const fallbackIndex = blocks.indexOf(fallbackBlock);
      if (placed[fallbackIndex] === null) {
        placed[fallbackIndex] = permission;
        continue;
      }
    }
    standalone.push(permission);
  }

  // Pass 3: assemble — attached blocks swap in their permission variant,
  // unattached permissions render as independent trailing cards.
  const items: FlatItem[] = blockItems.map((item, i) =>
    placed[i] ? blockItem(item.key, item.block, item.streaming, placed[i]) : item,
  );
  for (const permission of standalone) {
    items.push(standaloneItem(permission));
  }
  // Elicitations always trail the flow as independent cards, record order.
  for (const elicitation of attachedElicitations(doc.elicitations)) {
    items.push(standaloneElicitationItem(elicitation));
  }

  docItemsCache.set(doc, items);
  return items;
}

/** Every elicitation record — pending forms and settled results both render. */
function attachedElicitations(record: Record<string, ElicitationState>): AttachedElicitation[] {
  const cached = attachedElicitationListCache.get(record);
  if (cached) return cached;
  const list = Object.values(record).map((state) => {
    const wrapper = attachedElicitationCache.get(state);
    if (wrapper) return wrapper;
    const next: AttachedElicitation =
      state.status === 'pending'
        ? { state: 'pending', request: state.request }
        : { state: 'settled', request: state.request, response: state.response! };
    attachedElicitationCache.set(state, next);
    return next;
  });
  attachedElicitationListCache.set(record, list);
  return list;
}

/** Pending requests and policy-denied records — the renderable permission set. */
function attachedPermissions(record: Record<string, PermissionState>): AttachedPermission[] {
  const cached = attachedListCache.get(record);
  if (cached) return cached;
  const list = Object.values(record).flatMap((permission): AttachedPermission[] => {
    if (permission.status === 'pending') return [attachedPermission(permission)];
    if (permission.response?.outcome === 'denied-by-policy') return [attachedPermission(permission)];
    return [];
  });
  attachedListCache.set(record, list);
  return list;
}

function attachedPermission(permission: PermissionState): AttachedPermission {
  const cached = attachedCache.get(permission);
  if (cached) return cached;
  if (permission.status === 'pending') {
    const wrapper: AttachedPermission = { state: 'pending', request: permission.request };
    attachedCache.set(permission, wrapper);
    return wrapper;
  }
  const response = permission.response;
  if (response?.outcome !== 'denied-by-policy') {
    // attachedPermissions filters to the two renderable states; reaching here
    // means the filter and the wrapper drifted — fail loudly, never guess.
    throw new Error(`[projector] unexpected permission state to attach: ${permission.status}`);
  }
  const wrapper: AttachedPermission = { state: 'denied', request: permission.request, response };
  attachedCache.set(permission, wrapper);
  return wrapper;
}

function blockItem(
  key: string,
  block: Block,
  streaming: boolean,
  permission: AttachedPermission | null,
): BlockFlatItem {
  if (!streaming && !permission) {
    let base = baseItemCache.get(block);
    if (!base) {
      base = { key, kind: 'block', block, streaming: false, permission: null };
      baseItemCache.set(block, base);
    }
    return base;
  }
  const cached = variantItemCache.get(block);
  if (cached && cached.streaming === streaming && cached.permission === permission) return cached.item;
  const item: BlockFlatItem = { key, kind: 'block', block, streaming, permission };
  variantItemCache.set(block, { streaming, permission, item });
  return item;
}

function standaloneItem(permission: AttachedPermission): StandalonePermissionItem {
  const cached = standaloneItemCache.get(permission);
  if (cached) return cached;
  const item: StandalonePermissionItem = {
    key: `${permission.state}-${permission.request.toolCallId}`,
    kind: 'permission',
    permission,
  };
  standaloneItemCache.set(permission, item);
  return item;
}

function standaloneElicitationItem(elicitation: AttachedElicitation): StandaloneElicitationItem {
  const cached = standaloneElicitationItemCache.get(elicitation);
  if (cached) return cached;
  const item: StandaloneElicitationItem = {
    key: elicitation.request.id,
    kind: 'elicitation',
    elicitation,
  };
  standaloneElicitationItemCache.set(elicitation, item);
  return item;
}

/**
 * While running, one trailing block of the last turn is "streaming" and its
 * live affordances (message cursor, thought tail preview) are on:
 *
 *  - a thought is streaming only while it is the VERY LAST block — the
 *    moment any plan/tool_call/message follows, its Thinking label settles
 *    to Thought;
 *  - an agent message keeps its cursor even with tool calls running below
 *    it (the original behavior), so the scan skips non-streaming blocks.
 */
function findStreamingBlock(doc: SessionDocument): Block | null {
  if (doc.status !== 'running') return null;
  const lastTurn = doc.turns.at(-1);
  if (!lastTurn) return null;
  const last = lastTurn.blocks.at(-1);
  if (last?.kind === 'thought') return last;
  for (let i = lastTurn.blocks.length - 1; i >= 0; i--) {
    const block = lastTurn.blocks[i]!;
    if (block.kind === 'agent_message') return block;
    if (block.kind === 'thought') return null;
  }
  return null;
}
