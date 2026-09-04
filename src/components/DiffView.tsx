import { useEffect, useMemo, useState } from 'react';
import type { AcpToolCallContent } from '../protocol/types';
import { highlightLines, type TokenSpan } from '../highlight/highlighter';
import { computeRows, diffStats, intersectSpans, withWordSpans, type DiffRow } from './diff-utils';
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
  const rows = useMemo(
    () => withWordSpans(computeRows(oldText, diff.newText)),
    [oldText, diff.newText],
  );
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
      </div>
      <div className="diff-scroll">
        <table className="diff-table">
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className={ROW_BG[row.type]}>
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
                  <LineContent row={row} tokens={tokenLineFor(row, lines)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
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