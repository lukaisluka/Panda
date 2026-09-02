import { useState } from 'react';
import { Brain, ChevronDown } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Block } from '../protocol/types';
import { MessageImage } from './MessageImage';

type ThoughtBlockModel = Extract<Block, { kind: 'thought' }>;

/** Collapsed by default; the header peeks at the first text line while streaming. */
export function ThoughtBlock({ block }: { block: ThoughtBlockModel }) {
  const [open, setOpen] = useState(false);
  const firstText = block.parts.find((part) => part.type === 'text');
  const preview =
    firstText?.type === 'text' ? (firstText.text.split('\n')[0]?.slice(0, 60) ?? '') : '';

  return (
    <div className="my-2 rounded-lg border border-border/70 bg-surface/60">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted transition-colors hover:text-fg"
      >
        <Brain size={13} className="shrink-0 text-faint" />
        <span className="truncate italic">{open ? '思考过程' : preview || 'Thinking…'}</span>
        <ChevronDown
          size={13}
          className={`ml-auto shrink-0 text-faint transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="md-body border-t border-border/70 px-3.5 py-2.5 text-[13px] italic text-muted">
          {block.parts.map((part, i) =>
            part.type === 'image' ? (
              <MessageImage key={i} image={part} />
            ) : (
              <ReactMarkdown key={i} remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown>
            ),
          )}
        </div>
      )}
    </div>
  );
}