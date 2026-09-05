import { CircleStop, Hand, ListEnd, Timer } from 'lucide-react';
import type { Block } from '../protocol/types';

type TurnNoticeModel = Extract<Block, { kind: 'turn_notice' }>;

/** Copy + icon per stop reason. end_turn never reaches this component (the
 * driver filters it) — it is the unremarkable ending and needs no row. */
const REASONS = {
  cancelled: { icon: CircleStop, text: '已取消' },
  refusal: { icon: Hand, text: '模型拒绝了本次请求' },
  max_tokens: { icon: Timer, text: '输出达到长度上限(max_tokens)' },
  max_turn_requests: { icon: ListEnd, text: '达到单回合请求上限(max_turn_requests)' },
} as const;

/**
 * System row for a turn that ended abnormally (PromptResponse.stopReason ≠
 * end_turn). A quiet centered line — the fact must be visible, not loud.
 */
export function TurnNotice({ block }: { block: TurnNoticeModel }) {
  const { icon: Icon, text } = REASONS[block.stopReason];
  return (
    <div className="turn-notice" role="status">
      <Icon size={13} className="turn-notice-icon" />
      <span>{text}</span>
    </div>
  );
}
