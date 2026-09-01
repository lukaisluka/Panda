import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Block } from '../protocol/types';

type UserMessageBlock = Extract<Block, { kind: 'user_message' }>;

/** Left-aligned soft block — full-width layout, no chat bubbles. */
export function UserMessage({ block }: { block: UserMessageBlock }) {
  const md = block.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n\n');
  return (
    <div className="my-4">
      <div className="md-body max-w-[85%] rounded-2xl rounded-tl-md border border-border/50 bg-raised/70 px-4 py-3">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>
      </div>
    </div>
  );
}