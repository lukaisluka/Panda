// 沙箱种子项目:测试 agent 的 read/edit/execute 都发生在这里。
// scenarios.py 的 edit_file old_string 必须与本文件精确对应。

export interface Session {
  userId: string;
  token: string;
  expiresAt: number;
}

export function validateSession(session: Session | null): boolean {
  if (session == null) {
    return false;
  }
  if (session.token.length < 20) {
    return false;
  }
  if (session.expiresAt < Date.now()) {
    return false;
  }
  return true;
}

export function authorize(session: Session | null, requiredRole: string): boolean {
  if (validateSession(session) == false) {
    return false;
  }
  return requiredRole.length > 0;
}