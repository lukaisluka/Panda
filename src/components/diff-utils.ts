import { diffLines } from 'diff';

/** Line-level additions/deletions between two full texts (ACP sends whole files). */
export function diffStats(oldText: string | null, newText: string): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const change of diffLines(oldText ?? '', newText)) {
    const lineCount = change.value.replace(/\n$/, '').split('\n').length;
    if (change.added) additions += lineCount;
    else if (change.removed) deletions += lineCount;
  }
  return { additions, deletions };
}