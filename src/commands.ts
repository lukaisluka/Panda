import type { AcpAvailableCommand } from './protocol/types';

/**
 * Slash-command autocomplete for the composer, over the agent-advertised
 * command list (`available_commands_update`). Pure functions — the panel's
 * open/closed state derives entirely from the input text, so a completed
 * command ("/name " with its trailing space) closes the panel by itself.
 */

/**
 * Commands matching the input, or null when the panel must stay closed.
 * The panel opens only while the input is exactly `/` + a partial command
 * name (no space yet): once the user is typing arguments ("/tag v1.3…")
 * the name is settled and name suggestions would only be noise. Matching is
 * case-insensitive and order-preserving (the agent's list order wins).
 */
export function matchCommands(
  commands: AcpAvailableCommand[],
  value: string,
): AcpAvailableCommand[] | null {
  const token = /^\/(\S*)$/.exec(value);
  if (!token) return null;
  const query = (token[1] ?? '').toLowerCase();
  const items = commands.filter((command) => command.name.toLowerCase().startsWith(query));
  return items.length > 0 ? items : null;
}

/** The completed input for a command: `/name ` — the trailing space starts the argument. */
export function commandCompletion(command: AcpAvailableCommand): string {
  return `/${command.name} `;
}

/**
 * Keyboard behavior while the panel is open. Enter completes the highlighted
 * command instead of submitting (Shift+Enter still inserts a newline — the
 * caller falls through to the default handling); Tab completes; arrows wrap
 * around; Escape dismisses until the input changes.
 */
export type CommandKeyAction =
  | { type: 'complete' }
  | { type: 'move'; delta: 1 | -1 }
  | { type: 'close' }
  | null;

export function commandKeyAction(e: { key: string; shiftKey: boolean }): CommandKeyAction {
  switch (e.key) {
    case 'ArrowDown':
      return { type: 'move', delta: 1 };
    case 'ArrowUp':
      return { type: 'move', delta: -1 };
    case 'Tab':
      return { type: 'complete' };
    case 'Enter':
      return e.shiftKey ? null : { type: 'complete' };
    case 'Escape':
      return { type: 'close' };
    default:
      return null;
  }
}

/** Wraps the highlighted index around the item list (arrow navigation). */
export function wrapIndex(index: number, delta: 1 | -1, length: number): number {
  return (index + delta + length) % length;
}
