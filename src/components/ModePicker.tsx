import { useEffect, useRef, useState } from 'react';
import { Check, ChevronUp } from 'lucide-react';
import type { AcpSessionModeState } from '../protocol/types';
import './ModePicker.css';
import { useI18n } from '../i18n/context';

/**
 * Session-mode picker for the composer's bottom-left slot (protocol/v1
 * session-modes). Rendered only when the document has mode state — an agent
 * that advertises no modes shows no picker at all. Selection is
 * confirmation-driven: the pill's label follows the document (the resolved
 * `session/set_mode` RPC or the agent's `current_mode_update`), never a
 * local optimistic flip, so a failed switch visibly stays on the old mode.
 */
export function ModePicker({ modes, onSetMode }: {
  modes: AcpSessionModeState;
  onSetMode: (modeId: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = modes.availableModes.find((mode) => mode.id === modes.currentModeId);

  // The menu opens upward from the composer's bottom row; outside clicks and
  // Escape close it. Listeners mount only while open.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="mode-picker" ref={rootRef}>
      <button
        type="button"
        className="mode-picker-pill"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {current?.name ?? modes.currentModeId}
        <ChevronUp size={12} className={`mode-picker-chevron ${open ? 'mode-picker-chevron--open' : ''}`} />
      </button>
      {open && (
        <div className="mode-picker-menu" role="menu" aria-label={t('mode.menu')}>
          {modes.availableModes.map((mode) => {
            const isCurrent = mode.id === modes.currentModeId;
            return (
              <button
                key={mode.id}
                type="button"
                role="menuitemradio"
                aria-checked={isCurrent}
                className={`mode-picker-option ${isCurrent ? 'mode-picker-option--current' : ''}`}
                onClick={() => {
                  setOpen(false);
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
