/**
 * 会话元数据存储:sessionId → (threadId、模型、模式、标题、cwd)。
 *
 * LangGraph checkpointer 只存线程内容;session/load 还需要把 ACP 的
 * sessionId 对回 LangGraph 的 thread_id 以及该会话当前选的模型/模式,
 * 这些放在同一 SQLite 文件的独立表里,与 checkpointer 同库同生命周期。
 */

import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export interface SessionRecord {
  sessionId: string;
  threadId: string;
  /** 注册表里的模型 value(默认注册表第一项)。 */
  modelValue: string;
  /** 模式 id(默认 ask_before_edits)。 */
  modeId: string;
  /** 首条用户文本生成的标题;尚未发过消息时为 null。 */
  title: string | null;
  /** 建会话时的协议 cwd(仅信息性,不做相等校验)。 */
  cwd: string;
  createdAt: string;
}

export class SessionStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS acp_sessions (
        session_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        model_value TEXT NOT NULL,
        mode_id TEXT NOT NULL,
        title TEXT,
        cwd TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  create(record: Omit<SessionRecord, 'sessionId' | 'threadId' | 'createdAt'>): SessionRecord {
    const full: SessionRecord = {
      ...record,
      sessionId: randomUUID().replace(/-/g, ''),
      threadId: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        'INSERT INTO acp_sessions (session_id, thread_id, model_value, mode_id, title, cwd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(full.sessionId, full.threadId, full.modelValue, full.modeId, full.title, full.cwd, full.createdAt);
    return full;
  }

  get(sessionId: string): SessionRecord | undefined {
    const row = this.db
      .prepare('SELECT session_id, thread_id, model_value, mode_id, title, cwd, created_at FROM acp_sessions WHERE session_id = ?')
      .get(sessionId) as
      | { session_id: string; thread_id: string; model_value: string; mode_id: string; title: string | null; cwd: string; created_at: string }
      | undefined;
    if (!row) {
      return undefined;
    }
    return {
      sessionId: row.session_id,
      threadId: row.thread_id,
      modelValue: row.model_value,
      modeId: row.mode_id,
      title: row.title,
      cwd: row.cwd,
      createdAt: row.created_at,
    };
  }

  update(sessionId: string, patch: Partial<Pick<SessionRecord, 'modelValue' | 'modeId' | 'title'>>): void {
    const sets: string[] = [];
    const values: (string | null)[] = [];
    if (patch.modelValue !== undefined) {
      sets.push('model_value = ?');
      values.push(patch.modelValue);
    }
    if (patch.modeId !== undefined) {
      sets.push('mode_id = ?');
      values.push(patch.modeId);
    }
    if (patch.title !== undefined) {
      sets.push('title = ?');
      values.push(patch.title);
    }
    if (sets.length === 0) {
      return;
    }
    this.db
      .prepare(`UPDATE acp_sessions SET ${sets.join(', ')} WHERE session_id = ?`)
      .run(...values, sessionId);
  }
}
