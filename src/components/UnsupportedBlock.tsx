import { useState } from 'react';
import { ChevronDown, CircleAlert } from 'lucide-react';
import type { Block } from '../protocol/types';

type UnsupportedBlockModel = Extract<Block, { kind: 'unsupported' }>;

/**
 * Fallback for protocol data this Panda version cannot interpret (unknown
 * sessionUpdate kinds, unsupported-only content). Collapsed by default; the
 * raw notification stays inspectable — unsupported ≠ dropped.
 */
export function UnsupportedBlock({ block }: { block: UnsupportedBlockModel }) {
  const [open, setOpen] = useState(false);
  const kind = block.notification.update.sessionUpdate;

  return (
    <div className="my-3 rounded-lg border border-border/70 bg-surface/60">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted transition-colors hover:text-fg"
      >
        <CircleAlert size={13} className="shrink-0 text-faint" />
        <span className="truncate">暂不支持的 ACP 事件 · {kind}</span>
        <ChevronDown
          size={13}
          className={`ml-auto shrink-0 text-faint transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <pre className="max-h-72 overflow-auto border-t border-border/70 px-3.5 py-2.5 text-left text-xs leading-relaxed text-muted">
          {JSON.stringify(block.notification, null, 2)}
        </pre>
      )}
    </div>
  );
}
