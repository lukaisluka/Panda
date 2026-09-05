import { useState } from 'react';
import { ChevronDown, CircleAlert } from 'lucide-react';
import type { Block } from '../protocol/types';
import './disclosure.css';
import { useI18n } from '../i18n/context';

type UnsupportedBlockModel = Extract<Block, { kind: 'unsupported' }>;

/**
 * Fallback for protocol data this Panda version cannot interpret (unknown
 * sessionUpdate kinds, unsupported-only content). Collapsed by default; the
 * raw notification stays inspectable — unsupported ≠ dropped.
 */
export function UnsupportedBlock({ block }: { block: UnsupportedBlockModel }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const kind = block.notification.update.sessionUpdate;

  return (
    <div className="disclosure">
      <button onClick={() => setOpen((o) => !o)} className="disclosure-toggle">
        <CircleAlert size={16} className="disclosure-icon" />
        <span className="disclosure-label">{t('unsupported.event', { kind })}</span>
        <ChevronDown
          size={13}
          className={`disclosure-chevron ${open ? 'disclosure-chevron--open' : ''}`}
        />
      </button>
      {open && (
        <pre className="disclosure-body disclosure-body--raw">
          {JSON.stringify(block.notification, null, 2)}
        </pre>
      )}
    </div>
  );
}
