/**
 * Status-aware tool titles (joint-debug): live agents stream their titles in
 * the progressive form ("Editing src/a.ts") and never rewrite them when the
 * call settles — the reference client flips the verb instead ("Edit
 * src/a.ts"). Panda rewrites at the display layer only; the protocol title
 * stays untouched in the document.
 *
 * think calls never reach this function: their titles are placeholders, so
 * ToolCallCard renders the fixed kind label straight from the dictionary
 * (tool.thinking/tool.thought). Not every verb has a distinct progressive
 * form ("Read x" reads the same both ways) — unmapped titles pass through
 * unchanged on purpose.
 */

/** Progressive → settled verb, first word of the title, case-preserving. */
const VERB_MAP: Record<string, string> = {
  thinking: 'thought',
  reading: 'read',
  editing: 'edit',
  writing: 'write',
  creating: 'create',
  deleting: 'delete',
  moving: 'move',
  searching: 'search',
  scanning: 'scan',
  fetching: 'fetch',
  running: 'run',
  executing: 'execute',
  building: 'build',
  testing: 'test',
  checking: 'check',
  listing: 'list',
  installing: 'install',
  updating: 'update',
};

/** A settled title keeps no trailing ellipsis — "Thinking…" → "Thought". */
function stripEllipsis(text: string): string {
  return text.replace(/\s*(…|\.{3})\s*$/, '');
}

function matchCase(source: string, replacement: string): string {
  if (source === source.toUpperCase() && source.length > 1) return replacement.toUpperCase();
  return replacement[0]!.toUpperCase() + replacement.slice(1);
}

/** Returns the display title for a tool call in the given status. */
export function settledToolTitle(
  title: string,
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled',
): string {
  if (!title) return title;
  if (status !== 'completed' && status !== 'failed') return title;
  const stripped = stripEllipsis(title);
  const [first, ...rest] = stripped.split(' ');
  if (!first) return stripped;
  const mapped = VERB_MAP[first.toLowerCase()];
  if (!mapped) return stripped;
  return [matchCase(first, mapped), ...rest].join(' ');
}
