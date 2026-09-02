import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Block } from '../protocol/types';
import { markdownComponents } from './CodeBlock';
import { MessageImage } from './MessageImage';

type AgentMessageBlock = Extract<Block, { kind: 'agent_message' }>;

/**
 * Splits markdown into top-level paragraphs on blank lines, without ever
 * splitting inside a fenced code block — completed paragraphs are frozen and
 * never re-parsed while the tail paragraph keeps streaming.
 */
export function splitTopLevel(md: string): string[] {
  const paragraphs: string[] = [];
  let current: string[] = [];
  let inFence = false;

  for (const line of md.split('\n')) {
    if (/^\s*(~~~|```)/.test(line)) inFence = !inFence;
    if (!inFence && line.trim() === '' && current.length > 0) {
      paragraphs.push(current.join('\n'));
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) paragraphs.push(current.join('\n'));
  return paragraphs;
}

/**
 * Memoized paragraph renderer. Because paragraphs are keyed by index and
 * finished paragraphs never change content again, React skips re-rendering
 * everything except the streaming tail on each chunk.
 */
const Paragraph = memo(function Paragraph({ md }: { md: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{md}</ReactMarkdown>;
});

/** One text part of a message: its own frozen-paragraph sequence. */
const TextPart = memo(function TextPart({ text, streamingTail }: { text: string; streamingTail: boolean }) {
  const paragraphs = splitTopLevel(text);
  return (
    <>
      {paragraphs.map((paragraph, i) => {
        const isStreamingTail = streamingTail && i === paragraphs.length - 1;
        // The cursor character rides inside the markdown text so it flows
        // inline — even into an unclosed code block mid-stream.
        return <Paragraph key={i} md={isStreamingTail ? `${paragraph} ▍` : paragraph} />;
      })}
    </>
  );
});

/**
 * An agent message renders its parts in arrival order: text parts keep the
 * frozen-paragraph streaming behavior, image parts are atomic.
 */
export function AgentMessage({ block, streaming }: {
  block: AgentMessageBlock;
  streaming: boolean;
}) {
  return (
    <div className="md-body my-1.5">
      {block.parts.map((part, i) =>
        part.type === 'image' ? (
          <MessageImage key={i} image={part} />
        ) : (
          <TextPart
            key={i}
            text={part.text}
            streamingTail={streaming && i === block.parts.length - 1}
          />
        ),
      )}
    </div>
  );
}