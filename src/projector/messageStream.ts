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

export type FlatItem = BlockFlatItem | StandalonePermissionItem;

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

  docItemsCache.set(doc, items);
  return items;
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

/**
 * While running, the trailing agent message of the last turn is the one still
 * streaming — the only block whose cursor/typing affordances should be live.
 */
function findStreamingBlock(doc: SessionDocument): Block | null {
  if (doc.status !== 'running') return null;
  const lastTurn = doc.turns.at(-1);
  if (!lastTurn) return null;
  for (let i = lastTurn.blocks.length - 1; i >= 0; i--) {
    const block = lastTurn.blocks[i]!;
    if (block.kind === 'agent_message') return block;
  }
  return null;
}
