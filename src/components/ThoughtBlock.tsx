import { useState } from 'react';
import { Brain, ChevronDown } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Block } from '../protocol/types';
import { markdownComponents } from './CodeBlock';
import { MessageImage } from './MessageImage';
import './disclosure.css';

type ThoughtBlockModel = Extract<Block, { kind: 'thought' }>;

/** Collapsed by default; the header peeks at the first text line while streaming. */
export function ThoughtBlock({ block }: { block: ThoughtBlockModel }) {
  const [open, setOpen] = useState(false);
  const firstText = block.parts.find((part) => part.type === 'text');
  const preview =
    firstText?.type === 'text' ? (firstText.text.split('\n')[0]?.slice(0, 60) ?? '') : '';

  return (
    <div className="disclosure">
      <button onClick={() => setOpen((o) => !o)} className="disclosure-toggle">
        <Brain size={13} className="disclosure-icon" />
        <span className="disclosure-label disclosure-label--italic">{open ? '思考过程' : preview || 'Thinking…'}</span>
        <ChevronDown
          size={13}
          className={`disclosure-chevron ${open ? 'disclosure-chevron--open' : ''}`}
        />
      </button>
      {open && (
        <div className="md-body md-body--sm disclosure-body disclosure-body--thought">
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
