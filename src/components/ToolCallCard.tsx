import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Spinner } from '@astryxdesign/core/Spinner';
import {
  ArrowRightLeft,
  Brain,
  Check,
  ChevronDown,
  CircleSlash,
  FilePen,
  FileText,
  Globe,
  Repeat,
  Search,
  ShieldAlert,
  SquareTerminal,
  Trash2,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  AcpToolKind,
  PermissionOptionKind,
  ToolCallState,
  ToolCallStatus,
} from '../protocol/types';
import { markdownComponents } from './CodeBlock';
import { DiffView } from './DiffView';
import { MessageImage } from './MessageImage';
import { AttachedPermissionCard } from './PermissionCard';
import type { AttachedPermission } from '../projector/messageStream';
import { diffStats } from './diff-utils';

const KIND_ICON: Record<AcpToolKind, LucideIcon> = {
  read: FileText,
  edit: FilePen,
  delete: Trash2,
  move: ArrowRightLeft,
  search: Search,
  execute: SquareTerminal,
  think: Brain,
  fetch: Globe,
  switch_mode: Repeat,
  other: Wrench,
};

function StatusBadge({ status }: { status: ToolCallStatus }) {
  switch (status) {
    case 'pending':
      return <Badge variant="warning" icon={<ShieldAlert size={12} />} label="等待批准" />;
    case 'in_progress':
      return <Badge variant="neutral" icon={<Spinner size="sm" />} label="执行中" />;
    case 'completed':
      return <Check size={14} className="shrink-0 text-accent" />;
    case 'failed':
      return <X size={14} className="shrink-0 text-danger" />;
    case 'cancelled':
      return <CircleSlash size={13} className="shrink-0 text-faint" />;
  }
}

const CARD_EDGE: Partial<Record<ToolCallStatus, string>> = {
  pending: 'border-l-2 border-l-warn/60',
  in_progress: 'border-l-2 border-l-accent/50',
  failed: 'border-l-2 border-l-danger/60',
};

/**
 * The workhorse of the message stream: a collapsed summary row that expands
 * into raw input + results. Arrival order is preserved; cards sit between
 * the text that surrounds them.
 */
export function ToolCallCard({ call, permission, onResolvePermission }: {
  call: ToolCallState;
  /** The permission attached to this call — pending (user answers) or
   * policy-denied (terminal record, issue #22). */
  permission: AttachedPermission | null;
  onResolvePermission: (kind: PermissionOptionKind) => void;
}) {
  const [open, setOpen] = useState(false);

  // Lifecycle choreography: auto-expand while running, collapse when done.
  useEffect(() => {
    setOpen(call.status === 'in_progress');
  }, [call.status]);

  const Icon = KIND_ICON[call.kind];
  const path = call.locations[0]?.path;
  const diffPart = call.content.find((c): c is Extract<typeof c, { type: 'diff' }> => c.type === 'diff');
  const stats = useMemo(
    () => (diffPart ? diffStats(diffPart.oldText, diffPart.newText) : null),
    [diffPart],
  );
  const hasDetails = (call.rawInput && Object.keys(call.rawInput).length > 0) || call.content.length > 0;

  return (
    <div className="my-3">
      <div className={`rounded-lg border border-border bg-surface transition-colors ${CARD_EDGE[call.status] ?? ''}`}>
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-raised/40"
        >
          <Icon size={14} className="shrink-0 text-muted" />
          <span className="min-w-0 truncate text-xs text-fg/90">{call.title}</span>
          {stats && (
            <span className="shrink-0 font-mono text-[11px]">
              <span className="text-add">+{stats.additions}</span>{' '}
              <span className="text-danger">−{stats.deletions}</span>
            </span>
          )}
          {path && !call.title.includes(path) && (
            <span className="min-w-0 truncate font-mono text-[11px] text-faint">{path}</span>
          )}
          <span className="ml-auto flex items-center">
            <StatusBadge status={call.status} />
          </span>
          {hasDetails && (
            <ChevronDown
              size={13}
              className={`shrink-0 text-faint transition-transform ${open ? 'rotate-180' : ''}`}
            />
          )}
        </button>
      </div>

      {open && hasDetails && (
        <div className="mt-1.5 ml-2 space-y-2 border-l border-border pl-3">
          {call.rawInput && Object.keys(call.rawInput).length > 0 && (
            <details className="group rounded-md border border-border/70 bg-surface/60">
              <summary className="cursor-pointer select-none px-3 py-1.5 text-[11px] font-medium text-faint transition-colors group-open:text-muted hover:text-fg">
                Input
              </summary>
              <pre className="overflow-x-auto px-3 pb-2.5 font-mono text-[11px] leading-relaxed text-muted">
                {JSON.stringify(call.rawInput, null, 2)}
              </pre>
            </details>
          )}
          {call.content.map((item, i) => {
            if (item.type === 'diff') return <DiffView key={i} diff={item} />;
            if (item.type === 'content' && item.content.type === 'image') {
              return <MessageImage key={i} image={item.content} />;
            }
            if (item.type === 'content' && item.content.type === 'text') {
              return (
                <div key={i} className="md-body md-body--sm rounded-lg border border-border/70 bg-surface/60 px-3.5 py-2.5 text-muted">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{item.content.text}</ReactMarkdown>
                </div>
              );
            }
            return null;
          })}
          {call.status === 'in_progress' && call.content.length === 0 && (
            <div className="flex items-center gap-2 px-1 py-0.5 text-xs text-faint">
              <Spinner size="sm" /> 等待输出…
            </div>
          )}
        </div>
      )}

      {permission && (
        <AttachedPermissionCard permission={permission} onResolve={onResolvePermission} />
      )}
    </div>
  );
}