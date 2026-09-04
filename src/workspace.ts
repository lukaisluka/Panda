/**
 * 工作区(issue #23, ADR 0005):Agent 配置上的可选工作上下文——某个本机
 * 文件夹,或无。它只决定「与该 agent 新开会话时把什么目录发给协议」和
 * 「会话怎么显示归属」,不承担组织会话的职责(侧栏仍按连接分组)。
 *
 * 协议侧 `session/new.cwd` 必填且惯例为绝对路径:工作区为「无」时 Panda
 * 固定发送常量 `WORKSPACE_NONE_CWD`。deepagents-acp 的 session/load 要求
 * cwd 与创建时逐字相等——固定常量跨重连天然满足;恢复会话一律照抄会话
 * 记录里 agent 回报的目录,不读连接级当前工作区。
 */

/** v1 的两种工作区(ADR 0005);联合结构对 remote-repository / project /
 * dataset 留扩展位——加 kind 时在此追加分支,派生与显示逻辑同文件收口。 */
export type Workspace =
  | { kind: 'local-directory'; path: string }
  | { kind: 'none' };

/** 工作区为「无」时发往协议的占位 cwd(ADR 0005:绝对路径惯例 + 跨重连
 * 字节稳定 + 被当作文件工具根时无害)。 */
export const WORKSPACE_NONE_CWD = '/';

/** 「无工作区」的显示名。 */
export const NO_WORKSPACE_LABEL = '无工作区';

/** The only place a Workspace becomes a protocol cwd. */
export function workspaceToCwd(workspace: Workspace): string {
  return workspace.kind === 'local-directory' ? workspace.path : WORKSPACE_NONE_CWD;
}

/**
 * The inverse of `workspaceToCwd`, for values that arrive as bare cwds
 * (remembered form defaults, a slot's last-used directory). `/` reads back
 * as 无工作区 — a session whose real working directory IS `/` therefore
 * displays as 无工作区; the accepted degenerate case (ADR 0005).
 */
export function cwdToWorkspace(cwd: string): Workspace {
  return cwd === WORKSPACE_NONE_CWD
    ? { kind: 'none' }
    : { kind: 'local-directory', path: cwd };
}

/** Runtime guard for values read from storage; rejects unknown kinds and
 * a local-directory without a usable path. */
export function isWorkspace(value: unknown): value is Workspace {
  if (typeof value !== 'object' || value === null) return false;
  const { kind, path } = value as Record<string, unknown>;
  if (kind === 'none') return true;
  return kind === 'local-directory' && typeof path === 'string' && path.length > 0;
}

/** Session-row label derived from the agent-reported working directory. */
export function workspaceLabel(cwd: string): string {
  if (cwd === WORKSPACE_NONE_CWD) return NO_WORKSPACE_LABEL;
  return cwd.split('/').filter(Boolean).at(-1) ?? cwd;
}

/** A Workspace as shown in tooltips and connection metadata. */
export function workspaceDisplay(workspace: Workspace): string {
  return workspace.kind === 'local-directory' ? workspace.path : NO_WORKSPACE_LABEL;
}
