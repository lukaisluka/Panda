import { useMemo, useState } from 'react';
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
import { CodeBlock, markdownComponents } from './CodeBlock';
import { ClampBox } from './ClampBox';
import { DiffView } from './DiffView';
import { FileTypeIcon, splitFilePath } from './FileTypeIcon';
import { MessageImage } from './MessageImage';
import { AttachedPermissionCard } from './PermissionCard';
import type { AttachedPermission } from '../projector/messageStream';
import { diffStats } from './diff-utils';
import { settledToolTitle } from './tool-title';
import { specializeInput, type InputField } from './tool-input';
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

/** File-operating kinds get the ZCode-style row: kind icon + verb + file-type
 * icon + basename + parent dir + diff stats. The kind's verb is display-only
 * (from the protocol enum — stable, unlike titles); the original title
 * (verb + full path + notes) degrades to a hover tooltip on the basename. */
const FILE_VERB: Partial<Record<AcpToolKind, string>> = {
  read: 'Read',
  edit: 'Edit',
  delete: 'Delete',
  move: 'Move',
};

/** pending 的双语义:附着 pending 权限时是真在等用户批准;否则只是排队
 * (如同批工具被另一个工具的 HITL 中断连带挂起),不能谎称「等待批准」。 */
function StatusBadge({ status, permissionPending = false }: { status: ToolCallStatus; permissionPending?: boolean }) {
  switch (status) {
    case 'pending':
      return permissionPending ? (
        <Badge variant="warning" icon={<ShieldAlert size={12} />} label="等待批准" />
      ) : (
        <span title="同批工具里有一个在等审批;审批是按整批一起恢复的,批准后这张卡立即执行">
          <Badge variant="neutral" icon={<Spinner size="sm" />} label="排队中" />
        </span>
      );
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
 * the text that surrounds them. Expanding is purely manual — running cards
 * never pop open on their own (joint-debug decision; the think row streams
 * its tail, every other kind shows the status badge).
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

  // Inbound notifications are not schema-validated, so `kind` may be a
  // vendor/extension value outside the TS union (that's how switch_mode got
  // here). Fall back to the Wrench instead of rendering undefined.
  const Icon = KIND_ICON[call.kind] ?? Wrench;
  const path = call.locations[0]?.path;
  const line = call.locations[0]?.line;
  // Progressive → settled verb once the call ends ("Editing x" → "Edit x");
  // think calls show the fixed kind label instead (Thinking/Thought) —
  // protocol title is untouched in both cases, this is display-only.
  const displayTitle = settledToolTitle(call.title, call.status, call.kind);
  const live = call.status === 'pending' || call.status === 'in_progress';
  // Live think rows stream their tail beside the label: the latest text of
  // the call's (replace-style) content, one line, cut from the left so the
  // newest reasoning always stays visible — the full text needs expanding.
  const thinkPreview =
    call.kind === 'think' && live
      ? [...call.content].reverse().find((c): c is { type: 'content'; content: { type: 'text'; text: string } } => c.type === 'content' && c.content.type === 'text')?.content.text ?? ''
      : null;
  // File row data (null for non-file kinds or calls without a location).
  const fileVerb = path ? FILE_VERB[call.kind] : undefined;
  const fileRow = path && fileVerb ? { path, line, verb: fileVerb, ...splitFilePath(path) } : null;
  // read/search 的文本结果按原文(代码块)渲染,见 details 区注释。
  const rawTextKind = call.kind === 'read' || call.kind === 'search';
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
          {fileRow ? (
            <>
              <Icon size={16} className="tool-card-icon" />
              <span className="tool-card-title">{fileRow.verb}</span>
              <FileTypeIcon path={fileRow.path} />
              <span className="truncate tool-card-file" title={call.title}>{fileRow.base}</span>
              {fileRow.line != null && <span className="tool-card-line">:{fileRow.line}</span>}
              {fileRow.dir && <span className="truncate tool-card-path">{fileRow.dir}</span>}
            </>
          ) : (
            <>
              <Icon size={16} className="tool-card-icon" />
              {thinkPreview !== null ? (
                <>
                  <span className="tool-card-title">{displayTitle}</span>
                  <span className="tool-think-preview" dir="rtl">{thinkPreview}</span>
                </>
              ) : (
                <span className="truncate tool-card-title">{displayTitle}</span>
              )}
              {path && !call.title.includes(path) && (
                <span className="truncate tool-card-path">{path}</span>
              )}
            </>
          )}
          {stats && (
            <span className="tool-card-stats">
              <span className="tool-stats-add">+{stats.additions}</span>{' '}
              <span className="tool-stats-del">−{stats.deletions}</span>
            </span>
          )}
          <span className="tool-card-status">
            <StatusBadge status={call.status} permissionPending={permission?.state === 'pending'} />
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
          <InputSection call={call} />
          {hasRawOutput && (
            // 有 content 投影(文本/diff/图片)时原始 JSON 是双份信息,默认
            // 折叠;投影缺席时它是唯一结果,保持默认展开(#84)
            <details className="tool-input-details" open={call.content.length === 0}>
              <summary className="tool-input-summary">
                Output
              </summary>
              <ClampBox>
                <pre className="tool-input-pre">
                  {JSON.stringify(call.rawOutput, null, 2)}
                </pre>
              </ClampBox>
            </details>
          )}
          {call.content.map((item, i) => {
            if (item.type === 'diff') {
              return (
                <ClampBox key={i}>
                  <DiffView diff={item} />
                </ClampBox>
              );
            }
            if (item.type === 'content' && item.content.type === 'image') {
              return <MessageImage key={i} image={item.content} />;
            }
            if (item.type === 'content' && item.content.type === 'text') {
              // read/search 的文本结果是原文件/匹配行,过 markdown 会被
              // "翻译"变形(缩进 4 行变代码块、# 变标题)——按路径扩展名
              // 走代码块原文渲染,还自带复制按钮。execute/think 等的文本
              // 是 agent 产出的 markdown,保持原渲染。
              if (rawTextKind) {
                return (
                  <ClampBox key={i}>
                    <CodeBlock lang={extLang(path)} code={item.content.text} />
                  </ClampBox>
                );
              }
              return (
                <ClampBox key={i}>
                  <div className="md-body tool-text-box">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{item.content.text}</ReactMarkdown>
                  </div>
                </ClampBox>
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

/** Input 展开区(#83):主视图按 kind 特化,原始 JSON 永远收在折叠兜底。 */
function InputSection({ call }: { call: ToolCallState }) {
  const rawJson =
    call.rawInput && Object.keys(call.rawInput).length > 0
      ? JSON.stringify(call.rawInput, null, 2)
      : null;
  if (rawJson === null) return null;
  const view = specializeInput(call);

  if (view.kind === 'raw') {
    return (
      <details className="tool-input-details">
        <summary className="tool-input-summary">Input</summary>
        <ClampBox>
          <pre className="tool-input-pre">{rawJson}</pre>
        </ClampBox>
      </details>
    );
  }

  return (
    <>
      {view.kind === 'command' && (
        <div className="tool-input-command">
          <span className="tool-input-command-sign">$</span>
          <code>{view.command}</code>
        </div>
      )}
      {view.kind === 'code' && (
        <ClampBox>
          <CodeBlock lang={extLang(view.path)} code={view.code} />
        </ClampBox>
      )}
      {view.kind === 'command' && view.extras.length > 0 && <InputFields entries={view.extras} />}
      {view.kind === 'fields' && <InputFields entries={view.entries} />}
      <details className="tool-input-details tool-input-details--raw">
        <summary className="tool-input-summary">原始 JSON</summary>
        <ClampBox>
          <pre className="tool-input-pre">{rawJson}</pre>
        </ClampBox>
      </details>
    </>
  );
}

function InputFields({ entries }: { entries: InputField[] }) {
  return (
    <dl className="tool-input-fields">
      {entries.map(({ key, value }) => (
        <div key={key} className="tool-input-field">
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 路径扩展名 → CodeBlock 语言标签(highlighter 的别名表负责映射到 shiki)。
 * 无扩展名(pop 出带 / 的整段路径)时不标语言,纯文本渲染。 */
function extLang(path: string | undefined): string | null {
  if (!path) return null;
  const ext = path.split('.').pop() ?? '';
  if (!ext || ext.includes('/')) return null;
  return ext.toLowerCase();
}