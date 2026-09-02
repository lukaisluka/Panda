import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Block } from '../protocol/types';
import { MessageImage } from './MessageImage';

type UserMessageBlock = Extract<Block, { kind: 'user_message' }>;

/**
 * Left-aligned soft block — full-width layout, no chat bubbles. Consecutive
 * text blocks render as one markdown document, images render in place, order
 * preserved.
 */
export function UserMessage({ block }: { block: UserMessageBlock }) {
  const children: ReactNode[] = [];
  let textBuffer: string[] = [];
  const flush = () => {
    if (textBuffer.length === 0) return;
    const md = textBuffer.join('\n\n');
    children.push(<ReactMarkdown key={`t-${children.length}`} remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>);
    textBuffer = [];
  };
  for (const c of block.content) {
    if (c.type === 'text') textBuffer.push(c.text);
    else {
      flush();
      children.push(<MessageImage key={`i-${children.length}`} image={c} />);
    }
  }
  flush();

  return (
    <div className="my-4">
      <div className="md-body max-w-[85%] rounded-2xl rounded-tl-md border border-border/50 bg-raised/70 px-4 py-3">
        {children}
      </div>
    </div>
  );
}