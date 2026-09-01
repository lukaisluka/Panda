import { useMemo } from 'react';
import { diffLines } from 'diff';
import type { AcpToolCallContent } from '../protocol/types';
import { diffStats } from './diff-utils';

type DiffPart = Extract<AcpToolCallContent, { type: 'diff' }>;

type Row = {
  type: 'ctx' | 'add' | 'del';
  oldNo: number | null;
  newNo: number | null;
  text: string;
};

function computeRows(diff: DiffPart): Row[] {
  const rows: Row[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (const change of diffLines(diff.oldText ?? '', diff.newText)) {
    const lines = change.value.replace(/\n$/, '').split('\n');
    for (const text of lines) {
      if (change.added) rows.push({ type: 'add', oldNo: null, newNo: newNo++, text });
      else if (change.removed) rows.push({ type: 'del', oldNo: oldNo++, newNo: null, text });
      else rows.push({ type: 'ctx', oldNo: oldNo++, newNo: newNo++, text });
    }
  }
  return rows;
}

const ROW_BG: Record<Row['type'], string> = {
  add: 'bg-diff-add',
  del: 'bg-diff-del',
  ctx: '',
};

/** Full-file diff view: ACP delivers oldText/newText, we compute line pairs. */
export function DiffView({ diff }: { diff: DiffPart }) {
  const rows = useMemo(() => computeRows(diff), [diff]);
  const stats = useMemo(() => diffStats(diff.oldText, diff.newText), [diff]);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border bg-raised/40 px-3.5 py-2">
        <span className="font-mono text-xs text-muted">{diff.path}</span>
        <span className="font-mono text-xs">
          <span className="text-accent">+{stats.additions}</span>{' '}
          <span className="text-danger">−{stats.deletions}</span>
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-mono text-[12.5px] leading-[1.6]">
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className={ROW_BG[row.type]}>
                <td className="w-10 select-none px-2 text-right align-top text-faint/70">{row.oldNo ?? ''}</td>
                <td className="w-10 select-none px-2 text-right align-top text-faint/70">{row.newNo ?? ''}</td>
                <td
                  className={`w-4 select-none text-center align-top ${
                    row.type === 'add' ? 'text-accent' : row.type === 'del' ? 'text-danger' : 'text-transparent'
                  }`}
                >
                  {row.type === 'add' ? '+' : row.type === 'del' ? '−' : '·'}
                </td>
                <td className="whitespace-pre px-2 pr-4 align-top text-fg/85">{row.text || '\u00A0'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}