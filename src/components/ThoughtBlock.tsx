import { useState } from 'react';
import { Brain, ChevronDown } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Block } from '../protocol/types';
import { markdownComponents } from './CodeBlock';
import { MessageImage } from './MessageImage';
import './disclosure.css';

type ThoughtBlockModel = Extract<Block, { kind: 'thought' }>;

/**
 * ZCode-style thought row, same shape as a live think tool call: collapsed it
 * reads `🧠 Thinking <tail of the stream>` while streaming and settles to a
 * bare `🧠 Thought` once a later block exists (the projector's streaming flag
 * flips exactly then). The full reasoning text needs expanding.
 */
export function ThoughtBlock({ block, streaming }: { block: ThoughtBlockModel; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  // Parts merge consecutive text chunks (reducer appendPart), so the last
  // text part IS the full stream text — the preview shows its tail.
  const lastText = [...block.parts].reverse().find((part) => part.type === 'text');
  const tail = streaming && lastText?.type === 'text' ? lastText.text : null;

  return (
    <div className="disclosure">
      <button onClick={() => setOpen((o) => !o)} className="disclosure-toggle">
        <Brain size={16} className="disclosure-icon" />
        <span className="disclosure-label">{streaming ? 'Thinking' : 'Thought'}</span>
        {tail !== null && (
          <span className="tool-think-preview" dir="rtl">{tail}</span>
        )}
        <ChevronDown
          size={13}
          className={`disclosure-chevron ${open ? 'disclosure-chevron--open' : ''}`}
        />
      </button>
      {open && (
        <div className="md-body disclosure-body disclosure-body--thought">
          {block.parts.map((part, i) =>
            part.type === 'image' ? (
              <MessageImage key={i} image={part} />
            ) : (
              <ReactMarkdown key={i} remarkPlugins={[remarkGfm]} components={markdownComponents}>{part.text}</ReactMarkdown>
            ),
          )}
        </div>
      )}
    </div>
  );
}
