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
import { settledToolTitle } from './tool-title';
import './ToolCallCard.css';

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
      return <Check size={14} className="tool-status-icon tool-status-icon--ok" />;
    case 'failed':
      return <X size={14} className="tool-status-icon tool-status-icon--err" />;
    case 'cancelled':
      return <CircleSlash size={13} className="tool-status-icon tool-status-icon--faint" />;
  }
}

/**
 * The workhorse of the message stream: a collapsed summary row that expands
 * into raw input + results. Arrival order is preserved; cards sit between
 * the text that surrounds them.
 */
export function ToolCallCard({ call, permission, onResolvePermission, prevIsTool = false, nextIsTool = false }: {
  call: ToolCallState;
  /** Permission attached to this call — pending (user answers) or
   * policy-denied (terminal record, issue #22). */
  permission: AttachedPermission | null;
  onResolvePermission: (kind: PermissionOptionKind) => void;
  /** Stream neighbors (see isToolItem in MessageStream): drive the ZCode
   * spacing ladder — 8px inside a tool run, 14px against text. */
  prevIsTool?: boolean;
  nextIsTool?: boolean;
}) {
  const [open, setOpen] = useState(false);

  // Lifecycle choreography: auto-expand while running, collapse when done.
  useEffect(() => {
    setOpen(call.status === 'in_progress');
  }, [call.status]);

  // Inbound notifications are not schema-validated, so `kind` may be a
  // vendor/extension value outside the TS union (that's how switch_mode got
  // here). Fall back to the Wrench instead of rendering undefined.
  const Icon = KIND_ICON[call.kind] ?? Wrench;
  const path = call.locations[0]?.path;
  // Progressive → settled verb once the call ends ("Editing x" → "Edit x");
  // empty think titles get their kind default ("Thinking…"/"Thought").
  // Protocol title is untouched — this is display-only.
  const displayTitle = settledToolTitle(call.title, call.status, call.kind);
  const diffPart = call.content.find((c): c is Extract<typeof c, { type: 'diff' }> => c.type === 'diff');
  const stats = useMemo(
    () => (diffPart ? diffStats(diffPart.oldText, diffPart.newText) : null),
    [diffPart],
  );
  const hasRawOutput = !!call.rawOutput && Object.keys(call.rawOutput).length > 0;
  const hasDetails =
    (call.rawInput && Object.keys(call.rawInput).length > 0) ||
    hasRawOutput ||
    call.content.length > 0;

  return (
    <div
      className={[
        'tool-card',
        prevIsTool && 'tool-card--after-tool',
        nextIsTool && 'tool-card--before-tool',
      ].filter(Boolean).join(' ')}
    >
      <div className="tool-card-frame">
        <button onClick={() => setOpen((o) => !o)} className="tool-card-toggle">
          <Icon size={14} className="tool-card-icon" />
          <span className="truncate tool-card-title">{displayTitle}</span>
          {stats && (
            <span className="tool-card-stats">
              <span className="tool-stats-add">+{stats.additions}</span>{' '}
              <span className="tool-stats-del">−{stats.deletions}</span>
            </span>
          )}
          {path && !call.title.includes(path) && (
            <span className="truncate tool-card-path">{path}</span>
          )}
          <span className="tool-card-status">
            <StatusBadge status={call.status} />
          </span>
          {hasDetails && (
            <ChevronDown
              size={13}
              className={`tool-card-chevron ${open ? 'tool-card-chevron--open' : ''}`}
            />
          )}
        </button>
      </div>

      {open && hasDetails && (
        <div className="tool-card-details">
          {call.rawInput && Object.keys(call.rawInput).length > 0 && (
            <details className="tool-input-details">
              <summary className="tool-input-summary">
                Input
              </summary>
              <pre className="tool-input-pre">
                {JSON.stringify(call.rawInput, null, 2)}
              </pre>
            </details>
          )}
          {hasRawOutput && (
            <details className="tool-input-details" open>
              <summary className="tool-input-summary">
                Output
              </summary>
              <pre className="tool-input-pre">
                {JSON.stringify(call.rawOutput, null, 2)}
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
                <div key={i} className="md-body tool-text-box">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{item.content.text}</ReactMarkdown>
                </div>
              );
            }
            if (item.type === 'unsupported') {
              return (
                <div key={i} className="tool-unsupported">
                  未支持的内容块({item.blockType})
                </div>
              );
            }
            return <div key={i} className="tool-unsupported">未支持的内容块({String(item.type)})</div>;
          })}
          {call.status === 'in_progress' && call.content.length === 0 && (
            <div className="tool-waiting">
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