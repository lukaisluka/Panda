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
import { Archive, ArrowDown, TriangleAlert } from 'lucide-react';
import { Spinner } from '@astryxdesign/core/Spinner';
import type { Block, ElicitationResponse, PermissionOptionKind } from '../protocol/types';
import { AgentMessage } from './AgentMessage';
import { ThoughtBlock } from './ThoughtBlock';
import { ToolCallCard } from './ToolCallCard';
import { UserMessage } from './UserMessage';
import { ContentColumn } from './ContentColumn';
import { AttachedPermissionCard } from './PermissionCard';
import { ElicitationCard } from './ElicitationCard';
import { ElicitationUrlCard } from './ElicitationUrlCard';
import { UnsupportedBlock } from './UnsupportedBlock';
import { TurnNotice } from './TurnNotice';
import { useMessageStreamItems } from '../projector/hooks';
import type { AttachedPermission, BlockFlatItem, FlatItem } from '../projector/messageStream';
import './MessageStream.css';

/** Tool-run membership for the ZCode spacing ladder: cards inside a run
 * of consecutive tool_call blocks sit 8px apart; run edges against text
 * stay at 14px. CSS can't express this across the virtualizer's item
 * wrappers, so the flat sequence decides it here. */
const isToolItem = (item: FlatItem | undefined): item is BlockFlatItem =>
  item?.kind === 'block' && item.block.kind === 'tool_call';

/**
 * Scroll-following policy: stick to the bottom while the user is already
 * there; scrolling away detaches and floats the "jump to latest" button.
 *
 * Long sessions are virtualized (react-virtuoso); the projection preserves
 * untouched item identities (ADR 0006) so memoized rows skip re-renders on
 * every streamed chunk.
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

// Stable identities — changing component types in `components` remounts the
// scroller and resets the scroll position.
const StreamHeader = () => <div className="stream-header-space" />;
const StreamFooter = () => <div className="stream-footer-space" />;

export function MessageStream({ onResolvePermission, onResolveElicitation, onOpenElicitationUrl }: {
  onResolvePermission: (toolCallId: string, kind: PermissionOptionKind) => void;
  onResolveElicitation: (id: string, response: ElicitationResponse) => void;
  onOpenElicitationUrl: (id: string) => void;
}) {
  const [pinned, setPinned] = useState(true);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;

  const items = useMessageStreamItems();

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
    <div className="stream-root">
      <Virtuoso
        ref={virtuosoRef}
        data={items}
        className="stream-scroller"
        increaseViewportBy={{ top: 600, bottom: 600 }}
        computeItemKey={(_, item) => item.key}
        itemContent={(index, item) => {
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
          if (item.kind === 'elicitation') {
            return (
              <ContentColumn>
                {item.elicitation.request.mode === 'url' ? (
                  <ElicitationUrlCard
                    elicitation={item.elicitation}
                    onOpen={onOpenElicitationUrl}
                    onDecline={onResolveElicitation}
                  />
                ) : (
                  <ElicitationCard
                    elicitation={item.elicitation}
                    onResolve={onResolveElicitation}
                  />
                )}
              </ContentColumn>
            );
          }
          if (item.kind === 'compaction') {
            return (
              <ContentColumn>
                <div className="turn-notice" role="status">
                  <Spinner size="sm" className="turn-notice-icon" />
                  <span>正在压缩上下文…</span>
                </div>
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
                prevIsTool={isToolItem(items[index - 1])}
                nextIsTool={isToolItem(items[index + 1])}
              />
            </ContentColumn>
          );
        }}
        components={components}
      />

      {!pinned && (
        <button
          onClick={jumpToBottom}
          className="stream-jump"
          aria-label="回到最新"
        >
          <ArrowDown size={16} />
        </button>
      )}
    </div>
  );
}

/**
 * Shallow-compare memo: the projection keeps untouched item identities
 * (ADR 0006), so only the block a chunk landed in re-renders.
 */
const BlockView = memo(function BlockView({ block, streaming, permission, onResolvePermission, prevIsTool, nextIsTool }: {
  block: Block;
  streaming: boolean;
  permission: AttachedPermission | null;
  onResolvePermission: (toolCallId: string, kind: PermissionOptionKind) => void;
  /** Neighbor flags (primitive so the memo's shallow compare stays stable):
   * only tool_call blocks consume them — see isToolItem above. */
  prevIsTool: boolean;
  nextIsTool: boolean;
}) {
  switch (block.kind) {
    case 'user_message':
      return <UserMessage block={block} />;
    case 'agent_message':
      return <AgentMessage block={block} streaming={streaming} />;
    case 'thought':
      return <ThoughtBlock block={block} streaming={streaming} />;
    case 'tool_call':
      return (
        <ToolCallCard
          call={block.call}
          permission={permission}
          prevIsTool={prevIsTool}
          nextIsTool={nextIsTool}
          // Bound here (inside the memo) so the stable outer callback keeps
          // BlockView's shallow compare intact; the card only invokes it
          // while a pending permission is attached.
          onResolvePermission={(kind) => onResolvePermission(permission?.request.toolCallId ?? '', kind)}
        />
      );
    case 'turn_notice':
      return <TurnNotice block={block} />;
    case 'compaction_notice':
      return (
        <div className="turn-notice" role="status">
          {block.outcome === 'completed' ? (
            <>
              <Archive size={12} className="turn-notice-icon" />
              <span>上下文已压缩</span>
            </>
          ) : (
            <>
              <TriangleAlert size={12} className="turn-notice-icon" />
              <span>{block.error ? `上下文压缩失败：${block.error}` : '上下文压缩失败'}</span>
            </>
          )}
        </div>
      );
    case 'unsupported':
      return <UnsupportedBlock block={block} />;
  }
});
