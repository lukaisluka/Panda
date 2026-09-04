import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Block } from '../protocol/types';
import { markdownComponents } from './CodeBlock';
import { MessageImage } from './MessageImage';
import './messages.css';

type UserMessageBlock = Extract<Block, { kind: 'user_message' }>;

/**
 * Right-aligned chat bubble, capped at 70% of the content column. Consecutive
 * text blocks render as one markdown document, images render in place, order
 * preserved.
 */
export function UserMessage({ block }: { block: UserMessageBlock }) {
  const children: ReactNode[] = [];
  let textBuffer: string[] = [];
  const flush = () => {
    if (textBuffer.length === 0) return;
    const md = textBuffer.join('\n\n');
    children.push(<ReactMarkdown key={`t-${children.length}`} remarkPlugins={[remarkGfm]} components={markdownComponents}>{md}</ReactMarkdown>);
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
    <div className="user-message">
      <div className="md-body user-message-bubble">
        {children}
      </div>
    </div>
  );
}
