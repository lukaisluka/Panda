import { useState } from 'react';
import { Check, ChevronDown, Circle, CircleDot, ListTodo } from 'lucide-react';
import type { AcpPlanEntry } from '../protocol/types';
import './PlanDock.css';

/**
 * The session's plan, docked in the content area's top-right corner
 * (ZCode-style): plans are working state, not conversation flow, so the
 * latest plan floats above the stream instead of occupying a block in it.
 * Latest-wins — the dock always shows the agent's current plan. Collapsible:
 * the header keeps a `done/total` progress readout when folded.
 */
export function PlanDock({ entries }: { entries: AcpPlanEntry[] }) {
  const [open, setOpen] = useState(true);
  const done = entries.filter((entry) => entry.status === 'completed').length;

  return (
    <aside className="plan-dock" aria-label="会话计划">
      <button
        type="button"
        className="plan-dock-head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <ListTodo size={14} className="plan-dock-head-icon" />
        <span className="plan-dock-title">计划</span>
        <span className="plan-dock-progress">{done}/{entries.length}</span>
        <ChevronDown size={14} className={`plan-dock-chevron ${open ? 'plan-dock-chevron--open' : ''}`} />
      </button>
      {open && (
        <ol className="plan-dock-list">
          {entries.map((entry, i) => (
            <li key={i} className="plan-dock-item">
              {entry.status === 'completed' ? (
                <Check size={14} className="plan-dock-item-icon plan-dock-item-icon--done" />
              ) : entry.status === 'in_progress' ? (
                <CircleDot size={14} className="plan-dock-item-icon plan-dock-item-icon--active pulse" />
              ) : (
                <Circle size={14} className="plan-dock-item-icon" />
              )}
              <span
                className={
                  entry.status === 'completed'
                    ? 'plan-dock-item-text plan-dock-item-text--done'
                    : entry.status === 'in_progress'
                      ? 'plan-dock-item-text plan-dock-item-text--active'
                      : entry.priority === 'high'
                        ? 'plan-dock-item-text plan-dock-item-text--high'
                        : 'plan-dock-item-text'
                }
              >
                {entry.content}
              </span>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
