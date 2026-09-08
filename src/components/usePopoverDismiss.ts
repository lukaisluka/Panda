import { useEffect, useRef } from 'react';

/**
 * Shared dismiss behavior for the composer's anchored popovers (mode menu,
 * session-settings card, #215): while open, Escape and any pointerdown that
 * lands outside the anchor's subtree close it. Listeners mount only while
 * open — the same contract ModePicker hand-rolled first; the hook exists so
 * every popover in this area can't drift apart again.
 *
 * Returns the ref to attach to the popover's anchor element (the subtree
 * that counts as "inside" — typically the wrapper holding both the toggle
 * button and the floating card).
 */
export function usePopoverDismiss(open: boolean, close: () => void) {
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!anchorRef.current?.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  return anchorRef;
}
