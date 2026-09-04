import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
} from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { ArrowDown } from 'lucide-react';
import type {
  Block,
  PermissionOptionKind,
  SessionDocument,
} from '../protocol/types';
import { AgentMessage } from './AgentMessage';
import { PlanCard } from './PlanCard';
import { ThoughtBlock } from './ThoughtBlock';
import { ToolCallCard } from './ToolCallCard';
import { UserMessage } from './UserMessage';
import { ContentColumn } from './ContentColumn';
import { AttachedPermissionCard, type AttachedPermission } from './PermissionCard';
import { UnsupportedBlock } from './UnsupportedBlock';

/**
 * Scroll-following policy: stick to the bottom while the user is already
 * there; scrolling away detaches and floats the "jump to latest" button.
 *
 * Long sessions are virtualized (react-virtuoso); the reducer preserves
 * untouched block identities so memoized rows skip re-renders on every
 * streamed chunk.
 *
 * `pinned` semantics: unpinning requires USER intent (wheel/touch/key/
 * pointer input opens a short window in which scroll events may detach);
 * programmatic scrolls — our bottom-sticks and Virtuoso's size-recalc
 * position restores — can only ever re-pin. The bottom-stick itself goes
 * through Virtuoso's scrollToIndex (coordinated with its recalc machinery)
 * on every content change while pinned, rate-limited so burst replays
 * (session/load) don't choke it.
 */
/**
 * Bottom-stick rate limit: at burst frequency (session/load replays emit
 * hundreds of updates back-to-back) per-event scrolling chokes Virtuoso's
 * internal recalculation machinery and the view freezes behind the content.
 * Sticking at most every 40ms (leading + trailing) keeps normal streaming
 * effectively per-chunk while capping bursts at ~25Hz, which stays healthy.
 */
const STICK_INTERVAL_MS = 40;

const DETACH_DISTANCE_PX = 48;

type BlockFlatItem = {
  key: string;
  kind: 'block';
  block: Block;
  streaming: boolean;
  permission: AttachedPermission | null;
};

type StandalonePermissionItem = {
  key: string;
  kind: 'permission';
  permission: AttachedPermission;
};

export type FlatItem = BlockFlatItem | StandalonePermissionItem;

// Stable identities — changing component types in `components` remounts the
// scroller and resets the scroll position.
const StreamHeader = () => <div className="h-7" />;
const StreamFooter = () => <div className="h-[6.75rem]" />;

export function MessageStream({ doc, permissions, onResolvePermission }: {
  doc: SessionDocument;
  /**
   * Permission cards to render — pending requests (answered concurrently,
   * issue #18) plus policy-denied terminal records (issue #22). Minted by
   * App's memo: wrapper identities must survive unrelated document churn
   * or the memoized block views re-render on every chunk.
   */
  permissions: AttachedPermission[];
  onResolvePermission: (toolCallId: string, kind: PermissionOptionKind) => void;
}) {
  const [pinned, setPinned] = useState(true);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;

  const items = useMemo(
    () => flatten(doc, permissions, findStreamingBlock(doc)),
    [doc, permissions],
  );

  // Unpin is USER-intent only. Wheel/touch/key/pointer-down open a short
  // "user is scrolling" window; scroll events inside that window may unpin,
  // events outside it (our own sticks, Virtuoso's size-recalc position
  // restores) can only re-pin. Without this, recalc restore steps read as
  // upward scrolls and permanently detach the stream.
  const userScrollUntil = useRef(0);
  const markUserScroll = useCallback(() => {
    userScrollUntil.current = performance.now() + 350;
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (gap < DETACH_DISTANCE_PX) setPinned(true);
    else if (performance.now() < userScrollUntil.current) setPinned(false);
  }, []);

  // The Scroller component is created once per instance so it can capture
  // scrollerRef/handleScroll; identity must stay stable across renders
  // (changing component types in `components` remounts the scroller).
  const components = useMemo(() => {
    const Scroller = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
      function StreamScroller(props, ref) {
        const { onScroll, className, ...rest } = props;
        return (
          <div
            {...rest}
            className={`message-scroller ${className ?? ''}`}
            onScroll={(event) => {
              onScroll?.(event);
              handleScroll();
            }}
            onWheel={markUserScroll}
            onTouchMove={markUserScroll}
            onKeyDown={markUserScroll}
            onPointerDown={markUserScroll}
            ref={(el) => {
              scrollerRef.current = el;
              if (typeof ref === 'function') ref(el);
              else if (ref) ref.current = el;
            }}
          />
        );
      },
    );
    return { Scroller, Header: StreamHeader, Footer: StreamFooter };
  }, [handleScroll, markUserScroll]);

  // Stick to the bottom on every content change (new items AND last-item
  // growth) while pinned, rate-limited so burst replays don't churn the
  // scroll system. See runStick for why both scroll paths are used.
  const lastStickAt = useRef(0);
  const trailingTimer = useRef<number | null>(null);

  const runStick = useCallback(() => {
    lastStickAt.current = performance.now();
    // scrollToIndex stays coordinated with Virtuoso's recalc machinery during
    // bursts, but it relies on the last item's REGISTERED size — stale after
    // the item grew mid-stream, leaving a deterministic shortfall. Land on
    // the true bottom directly as well; recalc may revert the direct write
    // mid-burst (harmless, retried), while at rest it is exact.
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' });
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const stickToBottom = useCallback(() => {
    const elapsed = performance.now() - lastStickAt.current;
    if (elapsed >= STICK_INTERVAL_MS) {
      runStick();
      return;
    }
    if (trailingTimer.current !== null) return;
    trailingTimer.current = window.setTimeout(() => {
      trailingTimer.current = null;
      if (pinnedRef.current) runStick();
    }, STICK_INTERVAL_MS - elapsed);
  }, [runStick]);

  useLayoutEffect(() => {
    if (pinned) stickToBottom();
  }, [items, pinned, stickToBottom]);

  useEffect(
    () => () => {
      if (trailingTimer.current !== null) clearTimeout(trailingTimer.current);
    },
    [],
  );

  // Settling janitor: scrollToIndex can land short while Virtuoso's size
  // measurements are still settling (burst replays, late image loads, recalc
  // position restores). While pinned, close any residual gap on a slow cadence.
  useEffect(() => {
    if (!pinned) return undefined;
    const id = window.setInterval(() => {
      const el = scrollerRef.current;
      if (el && el.scrollHeight - el.scrollTop - el.clientHeight > 8) runStick();
    }, 300);
    return () => clearInterval(id);
  }, [pinned, runStick]);

  const jumpToBottom = () => {
    setPinned(true);
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'smooth' });
  };

  return (
    <div className="relative min-h-0 flex-1">
      <Virtuoso
        ref={virtuosoRef}
        data={items}
        className="h-full"
        increaseViewportBy={{ top: 600, bottom: 600 }}
        computeItemKey={(_, item) => item.key}
        itemContent={(_, item) => {
          if (item.kind === 'permission') {
            return (
              <ContentColumn>
                <AttachedPermissionCard
                  permission={item.permission}
                  onResolve={(kind) => onResolvePermission(item.permission.request.toolCallId, kind)}
                />
              </ContentColumn>
            );
          }
          return (
            <ContentColumn>
              <BlockView
                block={item.block}
                streaming={item.streaming}
                permission={item.permission}
                onResolvePermission={onResolvePermission}
              />
            </ContentColumn>
          );
        }}
        components={components}
      />

      {!pinned && (
        <button
          onClick={jumpToBottom}
          className="absolute bottom-4 right-6 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-raised text-muted shadow-lg transition-colors hover:text-fg"
          aria-label="回到最新"
        >
          <ArrowDown size={16} />
        </button>
      )}
    </div>
  );
}

export function flatten(
  doc: SessionDocument,
  permissions: AttachedPermission[],
  streamingBlock: Block | null,
): FlatItem[] {
  const items: FlatItem[] = [];
  for (const turn of doc.turns) {
    turn.blocks.forEach((block, i) => {
      items.push({
        key: `${turn.id}-${i}`,
        kind: 'block',
        block,
        streaming: block === streamingBlock,
        permission: null,
      });
    });
  }

  for (const permission of permissions) {
    attachPermission(items, doc, permission);
  }
  return items;
}

/**
 * Places one permission — pending or policy-denied alike — onto its exact
 * tool-call block, else onto the current turn's single pending call (some
 * ACP bridges emit an interrupt ID for request_permission instead of the
 * preceding tool_call ID — attach only when that leaves no doubt), else as
 * an independent card at the end. A block is only ever claimed by one
 * permission — a second one degrades to an independent card instead of
 * silently evicting the first.
 */
function attachPermission(items: FlatItem[], doc: SessionDocument, permission: AttachedPermission): void {
  const toolCallId = permission.request.toolCallId;
  const exactMatch = items.find(
    (item): item is BlockFlatItem =>
      item.kind === 'block' &&
      item.block.kind === 'tool_call' &&
      item.block.call.id === toolCallId,
  );
  if (exactMatch && exactMatch.permission === null) {
    exactMatch.permission = permission;
    return;
  }

  const currentTurn = doc.turns.at(-1);
  const pendingCalls = currentTurn?.blocks.filter(
    (block): block is Extract<Block, { kind: 'tool_call' }> =>
      block.kind === 'tool_call' && block.call.status === 'pending',
  ) ?? [];
  const fallbackMatch =
    pendingCalls.length === 1
      ? items.find(
          (item): item is BlockFlatItem => item.kind === 'block' && item.block === pendingCalls[0],
        )
      : undefined;
  if (fallbackMatch && fallbackMatch.permission === null) {
    fallbackMatch.permission = permission;
    return;
  }

  items.push({
    key: `${permission.state}-${toolCallId}`,
    kind: 'permission',
    permission,
  });
}

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

/**
 * Shallow-compare memo: the reducer keeps untouched block identities, so only
 * the block a chunk landed in re-renders.
 */
const BlockView = memo(function BlockView({ block, streaming, permission, onResolvePermission }: {
  block: Block;
  streaming: boolean;
  permission: AttachedPermission | null;
  onResolvePermission: (toolCallId: string, kind: PermissionOptionKind) => void;
}) {
  switch (block.kind) {
    case 'user_message':
      return <UserMessage block={block} />;
    case 'agent_message':
      return <AgentMessage block={block} streaming={streaming} />;
    case 'thought':
      return <ThoughtBlock block={block} />;
    case 'plan':
      return <PlanCard entries={block.entries} />;
    case 'tool_call':
      return (
        <ToolCallCard
          call={block.call}
          permission={permission}
          // Bound here (inside the memo) so the stable outer callback keeps
          // BlockView's shallow compare intact; the card only invokes it
          // while a pending permission is attached.
          onResolvePermission={(kind) => onResolvePermission(permission?.request.toolCallId ?? '', kind)}
        />
      );
    case 'unsupported':
      return <UnsupportedBlock block={block} />;
  }
});
