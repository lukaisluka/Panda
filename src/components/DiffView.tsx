import { useEffect, useMemo, useState } from 'react';
import type { AcpToolCallContent } from '../protocol/types';
import { highlightLines, type TokenSpan } from '../highlight/highlighter';
import { computeRows, diffStats, intersectSpans, withWordSpans, type DiffRow } from './diff-utils';

type DiffPart = Extract<AcpToolCallContent, { type: 'diff' }>;

const ROW_BG: Record<DiffRow['type'], string> = {
  add: 'bg-diff-add',
  del: 'bg-diff-del',
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
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border bg-raised/40 px-3.5 py-2">
        <span className="font-mono text-xs text-muted">{diff.path}</span>
        <span className="font-mono text-xs">
          <span className="text-add">+{stats.additions}</span>{' '}
          <span className="text-danger">−{stats.deletions}</span>
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-mono text-xs leading-[1.6]">
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className={ROW_BG[row.type]}>
                <td className="w-10 select-none px-2 text-right align-top text-faint/70">{row.oldNo ?? ''}</td>
                <td className="w-10 select-none px-2 text-right align-top text-faint/70">{row.newNo ?? ''}</td>
                <td
                  className={`w-4 select-none text-center align-top ${
                    row.type === 'add' ? 'text-add' : row.type === 'del' ? 'text-danger' : 'text-transparent'
                  }`}
                >
                  {row.type === 'add' ? '+' : row.type === 'del' ? '−' : '·'}
                </td>
                <td className="whitespace-pre px-2 pr-4 align-top text-fg/85">
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
                  ? 'rounded-[2px] bg-add/25'
                  : 'rounded-[2px] bg-danger/30'
                : undefined
          }
        >
          {seg.value}
        </span>
      ))}
    </>
  );
}