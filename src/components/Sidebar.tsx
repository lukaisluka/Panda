import { Bot } from 'lucide-react';

export function Sidebar() {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface/40">
      <div className="flex items-center gap-2.5 px-5 py-5 text-[15px] font-semibold tracking-tight">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-raised text-base">🐼</span>
        Panda
      </div>

      <div className="px-5 pb-2 text-[11px] font-medium uppercase tracking-wider text-faint">
        Sessions
      </div>
      <div className="px-3">
        <div className="rounded-lg bg-raised px-3 py-2.5 text-[13px] text-fg/90">
          重构 auth 校验
        </div>
      </div>

      <div className="mt-auto flex items-center gap-2 border-t border-border px-5 py-3.5 text-xs text-muted">
        <Bot size={14} className="shrink-0 text-accent" />
        <span className="truncate">claude-code · replay</span>
      </div>
    </aside>
  );
}