import { Check, Circle, CircleDot, ListTodo } from 'lucide-react';
import type { AcpPlanEntry } from '../protocol/types';
import './PlanCard.css';

/** Turn-scoped plan checklist — entries stream in as the agent works. */
export function PlanCard({ entries }: { entries: AcpPlanEntry[] }) {
  return (
    <div className="plan-card">
      <div className="plan-card-head">
        <ListTodo size={16} className="plan-card-head-icon" />
        计划
      </div>
      <ol className="plan-card-list">
        {entries.map((entry, i) => (
          <li key={i} className="plan-card-item">
            {entry.status === 'completed' ? (
              <Check size={15} className="plan-card-item-icon plan-card-item-icon--done" />
            ) : entry.status === 'in_progress' ? (
              <CircleDot size={15} className="plan-card-item-icon plan-card-item-icon--active pulse" />
            ) : (
              <Circle size={15} className="plan-card-item-icon" />
            )}
            <span
              className={
                entry.status === 'completed'
                  ? 'plan-card-item-text plan-card-item-text--done'
                  : entry.status === 'in_progress'
                    ? 'plan-card-item-text plan-card-item-text--active'
                    : 'plan-card-item-text'
              }
            >
              {entry.content}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
