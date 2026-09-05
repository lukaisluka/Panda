/**
 * Deterministic, protocol-safe titles for ACP sessions.
 *
 * The title comes from the first textual user message. It deliberately does
 * not make a second model request: creating a title must not add latency or
 * billable tokens to a conversation.
 */

const MAX_TITLE_LENGTH = 48;

/** Return a compact one-line title, or `null` for empty user input. */
export function titleFromFirstUserText(text: string): string | null {
  const normalized = text.split(/\s+/).join(' ').trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length <= MAX_TITLE_LENGTH) {
    return normalized;
  }
  return normalized.slice(0, MAX_TITLE_LENGTH - 1).trimEnd() + '…';
}
