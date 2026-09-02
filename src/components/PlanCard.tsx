import { Check, Circle, CircleDot, ListTodo } from 'lucide-react';
import type { AcpPlanEntry } from '../protocol/types';

/** Turn-scoped plan checklist — entries stream in as the agent works. */
export function PlanCard({ entries }: { entries: AcpPlanEntry[] }) {
  return (
    <div className="my-3 rounded-xl border border-border bg-surface px-4 py-3">
      <div className="mb-2.5 flex items-center gap-2 text-xs font-medium text-muted">
        <ListTodo size={14} className="text-accent" />
        计划
      </div>
      <ol className="space-y-1.5">
        {entries.map((entry, i) => (
          <li key={i} className="flex items-start gap-2.5 text-xs leading-relaxed">
            {entry.status === 'completed' ? (
              <Check size={15} className="mt-1 shrink-0 text-accent" />
            ) : entry.status === 'in_progress' ? (
              <CircleDot size={15} className="mt-1 shrink-0 animate-pulse text-accent" />
            ) : (
              <Circle size={15} className="mt-1 shrink-0 text-faint" />
            )}
            <span
              className={
                entry.status === 'completed'
                  ? 'text-faint line-through'
                  : entry.status === 'in_progress'
                    ? 'text-fg'
                    : 'text-muted'
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