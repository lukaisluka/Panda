import { CircleStop, Hand, ListEnd, Timer } from 'lucide-react';
import type { Block } from '../protocol/types';
import { useI18n } from '../i18n/context';

type TurnNoticeModel = Extract<Block, { kind: 'turn_notice' }>;

/** Copy + icon per stop reason. end_turn never reaches this component (the
 * driver filters it) — it is the unremarkable ending and needs no row. */
const REASONS = {
  cancelled: { icon: CircleStop, key: 'turn.cancelled' },
  refusal: { icon: Hand, key: 'turn.refusal' },
  max_tokens: { icon: Timer, key: 'turn.maxTokens' },
  max_turn_requests: { icon: ListEnd, key: 'turn.maxTurnRequests' },
} as const;

/**
 * System row for a turn that ended abnormally (PromptResponse.stopReason ≠
 * end_turn). A quiet centered line — the fact must be visible, not loud.
 */
export function TurnNotice({ block }: { block: TurnNoticeModel }) {
  const { t } = useI18n();
  const { icon: Icon, key } = REASONS[block.stopReason];
  return (
    <div className="turn-notice" role="status">
      <Icon size={13} className="turn-notice-icon" />
      <span>{t(key)}</span>
    </div>
  );
}
