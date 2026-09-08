import { useEffect, useRef, useState } from 'react';
import { Check, ChevronUp } from 'lucide-react';
import type { AcpSessionModeState } from '../protocol/types';
import './ModePicker.css';
import { useI18n } from '../i18n/context';
import { usePopoverDismiss } from './usePopoverDismiss';

/**
 * Session-mode picker for the composer's bottom-left slot (protocol/v1
 * session-modes). Rendered only when the document has mode state — an agent
 * that advertises no modes shows no picker at all. Selection is
 * confirmation-driven: the pill's label follows the document (the resolved
 * `session/set_mode` RPC or the agent's `current_mode_update`), never a
 * local optimistic flip, so a failed switch visibly stays on the old mode.
 *
 * Keyboard follows the APG menu pattern (#221): opening moves focus onto the
 * current (or first) option; ArrowUp/Down roam with wrap, Home/End jump,
 * Escape closes and returns focus to the pill, Tab closes behind the focus
 * move. Options are tabIndex=-1 — the menu is arrow territory, not tab-stop
 * territory.
 */
export function ModePicker({ modes, onSetMode }: {
  modes: AcpSessionModeState;
  onSetMode: (modeId: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // The menu opens upward from the composer's bottom row; outside clicks and
  // Escape close it (shared dismiss hook, #215 — same behavior as every
  // other anchored popover in the composer).
  const rootRef = usePopoverDismiss(open, () => setOpen(false));
  const pillRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = modes.availableModes.find((mode) => mode.id === modes.currentModeId);

  // Opening hands focus to the current option (else the first) — the arrows
  // then roam inside the menu (#221).
  useEffect(() => {
    if (!open) return;
    const options = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('.mode-picker-option') ?? [],
    );
    const first = options[0];
    if (!first) return;
    const target = options.find((option) => option.classList.contains('mode-picker-option--current')) ?? first;
    target.focus();
  }, [open]);

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const options = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('.mode-picker-option') ?? [],
    );
    const first = options[0];
    const last = options[options.length - 1];
    if (!first || !last) return;
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = index === -1 ? (delta === 1 ? 0 : options.length - 1) : (index + delta + options.length) % options.length;
      options[next]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      first.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      last.focus();
    } else if (event.key === 'Escape') {
      // The dismiss hook's document-level listener also closes; this branch
      // additionally lands focus back on the pill (APG menu).
      setOpen(false);
      pillRef.current?.focus();
    } else if (event.key === 'Tab') {
      // APG menu: Tab leaves the menu — it closes behind the focus move.
      setOpen(false);
    }
  };

  return (
    <div className="mode-picker" ref={rootRef}>
      <button
        type="button"
        ref={pillRef}
        className="mode-picker-pill"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(event) => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {current?.name ?? modes.currentModeId}
        <ChevronUp size={12} className={`mode-picker-chevron ${open ? 'mode-picker-chevron--open' : ''}`} />
      </button>
      {open && (
        <div className="mode-picker-menu" role="menu" aria-label={t('mode.menu')} onKeyDown={onMenuKeyDown} ref={menuRef}>
          {modes.availableModes.map((mode) => {
            const isCurrent = mode.id === modes.currentModeId;
            return (
              <button
                key={mode.id}
                type="button"
                role="menuitemradio"
                aria-checked={isCurrent}
                tabIndex={-1}
                className={`mode-picker-option ${isCurrent ? 'mode-picker-option--current' : ''}`}
                onClick={() => {
                  setOpen(false);
                  // Selection closes the menu — focus returns to the pill so
                  // keyboard users keep their place (APG menu).
                  pillRef.current?.focus();
                  if (!isCurrent) onSetMode(mode.id);
                }}
              >
                <Check size={14} className={`mode-picker-check ${isCurrent ? '' : 'mode-picker-check--hidden'}`} />
                <span className="mode-picker-option-text">
                  <span className="mode-picker-option-name">{mode.name}</span>
                  {mode.description && <span className="mode-picker-option-desc">{mode.description}</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
