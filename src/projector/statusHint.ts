/**
 * Composer hint copy (issue #24): the status line shown under the input.
 * Pure slice-in-string-out — every branch mirrors the component-era wording
 * and precedence exactly; this is a move, not a rewrite.
 *
 * Projection inputs are domain slices (ADR 0006): the hint reads both the
 * session document's status and the connection's, because "what should the
 * user be told" spans both facts.
 */

import type { SessionStatus } from '../protocol/types';
import type { ConnectionInfo, SessionMode } from '../store';

/** The fact slices the hint is derived from. */
export type StatusHintInput = {
  mode: SessionMode;
  docStatus: SessionStatus;
  connection: Pick<ConnectionInfo, 'status' | 'error'>;
  switching: boolean;
};

export function statusHint({ mode, docStatus, connection, switching }: StatusHintInput): string | undefined {
  if (mode !== 'live') {
    if (docStatus === 'requires_action') return '等待批准中…';
    if (docStatus === 'running') return 'Panda 正在工作…';
    return undefined;
  }
  if (connection.status === 'connecting') return '连接中…';
  if (connection.status === 'error') return '连接失败 — 在侧栏重连并恢复，或重新连接';
  if (connection.status === 'auth_required') return '需要登录 — 在上方选择登录方式';
  if (connection.status !== 'connected') return '未连接 ACP 服务 — 在侧栏连接';
  if (switching) return '切换会话中…';
  if (connection.error) return connection.error;
  if (docStatus !== 'idle') return 'Panda 正在工作…';
  return undefined;
}
