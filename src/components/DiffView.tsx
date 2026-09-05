import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { AcpToolCallContent } from '../protocol/types';
import { highlightLines, type TokenSpan } from '../highlight/highlighter';
import {
  computeRows,
  diffStats,
  foldRows,
  intersectSpans,
  unifiedPatch,
  withWordSpans,
  type DiffRow,
  type RowSegment,
} from './diff-utils';
import './DiffView.css';

type DiffPart = Extract<AcpToolCallContent, { type: 'diff' }>;

const ROW_BG: Record<DiffRow['type'], string> = {
  add: 'diff-row--add',
  del: 'diff-row--del',
  ctx: '',
};

/**
 * Full-file diff view: ACP delivers oldText/newText, we compute rows with
 * dual line numbers. Syntax tokens (shiki, lazy) and word-level highlights
 * (paired del/add runs) layer over the row backgrounds without changing
 * layout — tokens swap in asynchronously from plain text.
 */
export function DiffView({ diff }: { diff: DiffPart }) {
  const oldText = diff.oldText ?? '';
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );

  // 复制为标准 unified 补丁(#84):贴 PR 描述/别处 git apply 都能用。
  const copyPatch = async () => {
    try {
      await navigator.clipboard.writeText(unifiedPatch(diff.path, oldText, diff.newText));
      setCopied(true);
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => {
        copyTimer.current = null;
        setCopied(false);
      }, 1500);
    } catch (err) {
      console.error('[panda/diffview] clipboard write failed', err);
    }
  };
  const rows = useMemo(
    () => withWordSpans(computeRows(oldText, diff.newText)),
    [oldText, diff.newText],
  );
  // 大 diff 折叠未变更段(#88);展开状态按 fold id 记录,segments 随 rows
  // 记忆化,id 顺序稳定。
  const segments = useMemo(() => foldRows(rows), [rows]);
  const [expandedFolds, setExpandedFolds] = useState<ReadonlySet<number>>(() => new Set());
  const expandFold = (id: number) => {
    setExpandedFolds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };
  const stats = useMemo(() => diffStats(oldText, diff.newText), [oldText, diff.newText]);
  const [lines, setLines] = useState<{ old: TokenSpan[][] | null; new: TokenSpan[][] | null } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [oldLines, newLines] = await Promise.all([
        highlightLines(diff.path, oldText),
        highlightLines(diff.path, diff.newText),
      ]);
      if (!cancelled) setLines({ old: oldLines, new: newLines });
    })();
    return () => {
      cancelled = true;
    };
  }, [diff.path, oldText, diff.newText]);

  return (
    <div className="diff-container">
      <div className="diff-header">
        <span className="diff-header-path">{diff.path}</span>
        <span className="diff-header-lines">
          <span className="diff-lines-add">+{stats.additions}</span>{' '}
          <span className="diff-lines-del">−{stats.deletions}</span>
        </span>
        <button
          type="button"
          onClick={() => void copyPatch()}
          className="md-codeblock-copy"
          aria-label="复制补丁"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      <div className="diff-scroll">
        <table className="diff-table">
          <tbody>
            {segments.flatMap((seg) => renderSegment(seg, expandedFolds, expandFold, lines))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 未变更段(#88):折叠时渲染占位行,展开后渲染其全部行。 */
function renderSegment(
  seg: RowSegment,
  expandedFolds: ReadonlySet<number>,
  expandFold: (id: number) => void,
  lines: { old: TokenSpan[][] | null; new: TokenSpan[][] | null } | null,
) {
  if (seg.type !== 'fold') return [<DiffRowView key={`r-${seg.oldNo}-${seg.newNo}`} row={seg} tokens={tokenLineFor(seg, lines)} />];
  if (expandedFolds.has(seg.id)) {
    return seg.rows.map((row, i) => (
      <DiffRowView key={`f${seg.id}-${i}`} row={row} tokens={tokenLineFor(row, lines)} />
    ));
  }
  return [
    <tr key={`fold-${seg.id}`} className="diff-fold">
      <td colSpan={4}>
        <button type="button" className="diff-fold-btn" onClick={() => expandFold(seg.id)}>
          ⋯ {seg.rows.length} unchanged lines
        </button>
      </td>
    </tr>,
  ];
}

function DiffRowView({ row, tokens }: { row: DiffRow; tokens: TokenSpan[] | null }) {
  return (
    <tr className={ROW_BG[row.type]}>
      <td className="diff-gutter">{row.oldNo ?? ''}</td>
      <td className="diff-gutter">{row.newNo ?? ''}</td>
      <td
        className={`diff-marker ${
          row.type === 'add' ? 'diff-marker--add' : row.type === 'del' ? 'diff-marker--del' : ''
        }`}
      >
        {row.type === 'add' ? '+' : row.type === 'del' ? '−' : '·'}
      </td>
      <td className="diff-cell">
        <LineContent row={row} tokens={tokens} />
      </td>
    </tr>
  );
}

/** del/ctx rows read the old side, add rows the new side; ctx prefers the new. */
function tokenLineFor(
  row: DiffRow,
  lines: { old: TokenSpan[][] | null; new: TokenSpan[][] | null } | null,
): TokenSpan[] | null {
  if (!lines) return null;
  if (row.type === 'del') return lines.old?.[row.oldNo! - 1] ?? null;
  if (row.type === 'add') return lines.new?.[row.newNo! - 1] ?? null;
  return lines.new?.[row.newNo! - 1] ?? lines.old?.[row.oldNo! - 1] ?? null;
}

function LineContent({ row, tokens }: { row: DiffRow; tokens: TokenSpan[] | null }) {
  if (!tokens && !row.words) return <>{row.text || '\u00A0'}</>;
  const segments = intersectSpans(tokens, row.words);
  if (segments.length === 0) return <>{'\u00A0'}</>;
  return (
    <>
      {segments.map((seg, i) => (
        <span
          key={i}
          style={seg.color ? { color: seg.color } : undefined}
          className={
              seg.changed
                ? row.type === 'add'
                  ? 'diff-word--add'
                  : 'diff-word--del'
                : undefined
          }
        >
          {seg.value}
        </span>
      ))}
    </>
  );
}