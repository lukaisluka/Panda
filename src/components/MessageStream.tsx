import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import type {
  Block,
  PermissionOptionKind,
  PermissionRequest,
  SessionDocument,
} from '../protocol/types';
import { AgentMessage } from './AgentMessage';
import { PlanCard } from './PlanCard';
import { ThoughtBlock } from './ThoughtBlock';
import { ToolCallCard } from './ToolCallCard';
import { UserMessage } from './UserMessage';

/**
 * Scroll-following policy: stick to the bottom while the user is already
 * there; a scroll of more than 48px away detaches and floats the
 * "jump to latest" button.
 */
const DETACH_DISTANCE_PX = 48;

export function MessageStream({ doc, permission, onResolvePermission }: {
  doc: SessionDocument;
  permission: PermissionRequest | null;
  onResolvePermission: (kind: PermissionOptionKind) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < DETACH_DISTANCE_PX);
  };

  // Runs after every render (every streamed chunk); only scrolls when pinned.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
  });

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setPinned(true);
  };

  // The last agent message gets the streaming cursor while the turn runs.
  const streamingBlock = findStreamingBlock(doc);

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-7">
          {doc.turns.map((turn) =>
            turn.blocks.map((block, i) => (
              <BlockView
                key={`${turn.id}-${i}`}
                block={block}
                streaming={block === streamingBlock}
                permission={block.kind === 'tool_call' && permission?.toolCallId === block.call.id ? permission : null}
                onResolvePermission={onResolvePermission}
              />
            )),
          )}
          <div className="h-20" />
        </div>
      </div>

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

function BlockView({ block, streaming, permission, onResolvePermission }: {
  block: Block;
  streaming: boolean;
  permission: PermissionRequest | null;
  onResolvePermission: (kind: PermissionOptionKind) => void;
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
          onResolvePermission={onResolvePermission}
        />
      );
  }
}