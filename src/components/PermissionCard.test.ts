import { describe, expect, it } from 'vitest';
import { planBodyFromRawInput } from './PermissionCard';

describe('planBodyFromRawInput (#220: approval-card plan body shape guard)', () => {
  it('extracts entries from a write_todos-shaped rawInput', () => {
    expect(
      planBodyFromRawInput({
        todos: [
          { content: '通读 auth.ts 现有校验逻辑', status: 'completed' },
          { content: '收紧 authorize 的布尔判断', status: 'in_progress' },
          { content: '用命令验证改动后的文件', status: 'pending' },
        ],
      }),
    ).toEqual([
      { content: '通读 auth.ts 现有校验逻辑', status: 'completed' },
      { content: '收紧 authorize 的布尔判断', status: 'in_progress' },
      { content: '用命令验证改动后的文件', status: 'pending' },
    ]);
  });

  it('drops entries missing either field instead of rendering half a step', () => {
    expect(
      planBodyFromRawInput({
        todos: [{ content: '只有内容' }, { content: '完整条目', status: 'pending' }, { status: 'pending' }, null],
      }),
    ).toEqual([{ content: '完整条目', status: 'pending' }]);
  });

  it('returns null for non-plan shapes — the card stays title-only', () => {
    expect(planBodyFromRawInput(undefined)).toBeNull();
    expect(planBodyFromRawInput(null)).toBeNull();
    expect(planBodyFromRawInput('cat auth.ts')).toBeNull();
    expect(planBodyFromRawInput({ command: 'cat auth.ts' })).toBeNull();
    expect(planBodyFromRawInput({ todos: [] })).toBeNull();
    expect(planBodyFromRawInput({ todos: 'not-an-array' })).toBeNull();
    expect(planBodyFromRawInput({ todos: [{ nope: true }] })).toBeNull();
  });
});
