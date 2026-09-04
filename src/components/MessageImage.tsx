import type { AcpContentBlock } from '../protocol/types';
import './messages.css';

type ImageBlock = Extract<AcpContentBlock, { type: 'image' }>;

/** Inline image rendered from its base64 wire payload; shared by all block types. */
export function MessageImage({ image }: { image: ImageBlock }) {
  return (
    <img
      src={`data:${image.mimeType};base64,${image.data}`}
      alt=""
      loading="lazy"
      className="message-image"
    />
  );
}