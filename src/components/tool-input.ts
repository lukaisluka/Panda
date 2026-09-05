import type { ToolCallState } from '../protocol/types';

/**
 * Input 展开区的特化视图(#83):展开区不再裸倒 JSON,按 kind + 参数形状
 * 决定主视图,折叠行/diff 已覆盖的信息不重复展示。纯函数,无 React——
 * 完整 JSON 始终收在「原始 JSON」折叠兜底里,信息不丢。
 */

export type InputField = { key: string; value: string };

export type SpecializedInput =
  /** 没有值得单独展示的参数(全被折叠行/diff 覆盖或本就为空)。 */
  | { kind: 'none' }
  /** execute:命令以终端样式一行展示,其余标量参数附加在下方。 */
  | { kind: 'command'; command: string; extras: InputField[] }
  /** 写入类(edit kind 无 diff、rawInput 带 content):content 按路径扩展名代码块预览。 */
  | { kind: 'code'; path: string; code: string }
  /** 其余场景:剔除重复键后的标量键值对。 */
  | { kind: 'fields'; entries: InputField[] }
  /** 参数含对象/数组等复杂值:保持原始 JSON 视图(由调用方渲染)。 */
  | { kind: 'raw' };

/** 路径语义的参数键——折叠行已展示 locations 路径时不再重复。 */
const PATH_KEYS = new Set(['file_path', 'path', 'filePath', 'directory', 'dir']);

/** edit 的原文参数键——diff 已逐行覆盖,送 diff 时剔除。 */
const EDIT_TEXT_KEYS = new Set(['old_string', 'new_string', 'oldText', 'newText']);

export function specializeInput(
  call: Pick<ToolCallState, 'kind' | 'locations' | 'rawInput' | 'content'>,
): SpecializedInput {
  const raw = call.rawInput;
  if (!raw || typeof raw !== 'object' || Object.keys(raw).length === 0) {
    return { kind: 'none' };
  }

  if (call.kind === 'execute' && typeof raw.command === 'string') {
    return {
      kind: 'command',
      command: raw.command,
      // 复杂值参数不进主视图——「原始 JSON」折叠兜底就在旁边,一处不漏
      extras: fieldEntries(raw, ['command'], null) ?? [],
    };
  }

  // 协议无 write 枚举(kind=edit);edit_file 的 old/new 已由 diff 覆盖,
  // 而 rawInput 带 content 的写入型工具没有 diff——content 是唯一预览,
  // 按代码块展示(路径取 locations,退回参数里的路径键)。
  if (call.kind === 'edit' && typeof raw.content === 'string') {
    const path = call.locations[0]?.path ?? pathValue(raw);
    return { kind: 'code', path, code: raw.content };
  }

  const hasDiff = call.content.some((item) => item.type === 'diff');
  const dropped = [
    ...PATH_KEYS,
    ...(call.kind === 'edit' && hasDiff ? EDIT_TEXT_KEYS : []),
  ];
  const entries = fieldEntries(raw, dropped, call.locations[0]?.path ?? null);
  if (entries === null) return { kind: 'raw' };
  if (entries.length > 0) return { kind: 'fields', entries };
  return { kind: 'none' };
}

/**
 * 提取标量键值对(字符串/数字/布尔/null);出现对象/数组返回 null(调用方
 * 退回原始 JSON)。drop 中的路径键仅在取值确实与 locations 路径指同一处时
 * 剔除——指向别处的路径携带额外信息(如 grep 的子目录),保留。
 */
function fieldEntries(
  raw: Record<string, unknown>,
  droppedKeys: string[],
  locationPath: string | null,
): InputField[] | null {
  const dropped = new Set(droppedKeys);
  const entries: InputField[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const pathKeyPointsElsewhere =
      PATH_KEYS.has(key) && !sameLocation(value, locationPath);
    if (dropped.has(key) && !pathKeyPointsElsewhere) continue;
    if (value !== null && typeof value === 'object') return null;
    entries.push({ key, value: value === null ? 'null' : String(value) });
  }
  return entries;
}

function sameLocation(value: unknown, locationPath: string | null): boolean {
  if (typeof value !== 'string' || locationPath === null) return false;
  // 精确或互为后缀(绝对/相对路径、带不带尾斜杠的差异)
  return value === locationPath
    || value.endsWith(`/${locationPath}`)
    || locationPath.endsWith(`/${value}`)
    || (value.endsWith('/') && locationPath === value.slice(0, -1));
}

function pathValue(raw: Record<string, unknown>): string {
  for (const key of PATH_KEYS) {
    const value = raw[key];
    if (typeof value === 'string') return value;
  }
  return '';
}
