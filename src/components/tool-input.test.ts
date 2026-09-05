import { describe, expect, it } from 'vitest';
import { specializeInput } from './tool-input';
import type { ToolCallState } from '../protocol/types';

type Call = Pick<ToolCallState, 'kind' | 'locations' | 'rawInput' | 'content'>;

const call = (overrides: Partial<Call>): Call => ({
  kind: 'other',
  locations: [],
  rawInput: undefined,
  content: [],
  ...overrides,
});

describe('specializeInput', () => {
  it('空 rawInput → none', () => {
    expect(specializeInput(call({ rawInput: undefined }))).toEqual({ kind: 'none' });
    expect(specializeInput(call({ rawInput: {} }))).toEqual({ kind: 'none' });
  });

  it('execute:命令走终端视图,其余标量键附加', () => {
    expect(specializeInput(call({ kind: 'execute', rawInput: { command: 'pnpm test' } }))).toEqual({
      kind: 'command',
      command: 'pnpm test',
      extras: [],
    });
    expect(
      specializeInput(call({ kind: 'execute', rawInput: { command: 'ls', timeout_ms: 30 } })),
    ).toEqual({
      kind: 'command',
      command: 'ls',
      extras: [{ key: 'timeout_ms', value: '30' }],
    });
  });

  it('execute 无 command 键:退回键值视图', () => {
    expect(specializeInput(call({ kind: 'execute', rawInput: { cmd: 'ls' } }))).toEqual({
      kind: 'fields',
      entries: [{ key: 'cmd', value: 'ls' }],
    });
  });

  it('read:与 locations 同指一处的路径键剔除,剩余键保留', () => {
    expect(
      specializeInput(
        call({
          kind: 'read',
          locations: [{ path: 'src/auth/session.ts' }],
          rawInput: { file_path: 'src/auth/session.ts' },
        }),
      ),
    ).toEqual({ kind: 'none' });

    expect(
      specializeInput(
        call({
          kind: 'read',
          locations: [{ path: 'src/auth/session.ts' }],
          rawInput: { file_path: 'src/auth/session.ts', offset: 0, limit: 100 },
        }),
      ),
    ).toEqual({
      kind: 'fields',
      entries: [
        { key: 'offset', value: '0' },
        { key: 'limit', value: '100' },
      ],
    });
  });

  it('read 无 locations:路径键保留(折叠行没展示它)', () => {
    expect(
      specializeInput(call({ kind: 'read', rawInput: { file_path: 'a.ts' } })),
    ).toEqual({
      kind: 'fields',
      entries: [{ key: 'file_path', value: 'a.ts' }],
    });
  });

  it('edit 有 diff:old/new 与路径键剔除(diff 已覆盖)', () => {
    expect(
      specializeInput(
        call({
          kind: 'edit',
          locations: [{ path: 'a.ts' }],
          rawInput: { file_path: 'a.ts', old_string: 'x', new_string: 'y' },
          content: [{ type: 'diff', path: 'a.ts', oldText: 'x', newText: 'y' }],
        }),
      ),
    ).toEqual({ kind: 'none' });
  });

  it('edit 无 diff:old/new 保留(它们是唯一预览)', () => {
    const view = specializeInput(
      call({
        kind: 'edit',
        locations: [{ path: 'a.ts' }],
        rawInput: { file_path: 'a.ts', old_string: 'x', new_string: 'y' },
      }),
    );
    expect(view).toEqual({
      kind: 'fields',
      entries: [
        { key: 'old_string', value: 'x' },
        { key: 'new_string', value: 'y' },
      ],
    });
  });

  it('edit 带 content 键(写入型,协议无 write 枚举):代码块预览', () => {
    expect(
      specializeInput(
        call({
          kind: 'edit',
          locations: [{ path: 'src/new.ts' }],
          rawInput: { file_path: 'src/new.ts', content: 'export const x = 1;\n' },
        }),
      ),
    ).toEqual({ kind: 'code', path: 'src/new.ts', code: 'export const x = 1;\n' });
  });

  it('edit 带 content 但无 locations:路径退回参数键', () => {
    expect(
      specializeInput(call({ kind: 'edit', rawInput: { file_path: 'b.py', content: 'print(1)' } })),
    ).toEqual({ kind: 'code', path: 'b.py', code: 'print(1)' });
  });

  it('search:指向别处的路径键保留,同指一处的剔除', () => {
    expect(
      specializeInput(
        call({
          kind: 'search',
          locations: [{ path: 'src/auth/' }],
          rawInput: { pattern: 'verifySession', path: 'src/auth/' },
        }),
      ),
    ).toEqual({ kind: 'fields', entries: [{ key: 'pattern', value: 'verifySession' }] });

    expect(
      specializeInput(
        call({
          kind: 'search',
          locations: [{ path: 'src/auth/' }],
          rawInput: { pattern: 'x', path: 'src/auth/sub/' },
        }),
      ),
    ).toEqual({
      kind: 'fields',
      entries: [
        { key: 'pattern', value: 'x' },
        { key: 'path', value: 'src/auth/sub/' },
      ],
    });
  });

  it('对象/数组值:退回原始 JSON 视图', () => {
    expect(specializeInput(call({ rawInput: { name: 'x', options: { deep: true } } }))).toEqual({
      kind: 'raw',
    });
  });

  it('布尔与 null 值字符串化', () => {
    expect(
      specializeInput(call({ rawInput: { replace_all: false, note: null } })),
    ).toEqual({
      kind: 'fields',
      entries: [
        { key: 'replace_all', value: 'false' },
        { key: 'note', value: 'null' },
      ],
    });
  });

  it('路径键互为绝对/相对后缀视为同一处', () => {
    expect(
      specializeInput(
        call({
          kind: 'read',
          locations: [{ path: 'src/a.ts' }],
          rawInput: { file_path: '/repo/src/a.ts' },
        }),
      ),
    ).toEqual({ kind: 'none' });
  });
});
