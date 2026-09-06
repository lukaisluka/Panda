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
  /** 最近一次会话活动(prompt/resume/模式与配置变更)的时间;session/list 按它倒序。 */
  updatedAt: string;
}

/** session/list 的查询参数(分页与 cwd 过滤)。 */
export interface ListSessionsQuery {
  cwd?: string;
  limit?: number;
  offset?: number;
}

type SessionRow = {
  session_id: string;
  thread_id: string;
  model_value: string;
  mode_id: string;
  title: string | null;
  cwd: string;
  created_at: string;
  updated_at: string;
};

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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    // 旧库迁移:#97 之前建的表没有 updated_at;补列并回填 created_at,
    // 老会话的排序退化为按创建时间,语义自洽。
    const columns = this.db.prepare('PRAGMA table_info(acp_sessions)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'updated_at')) {
      this.db.exec("ALTER TABLE acp_sessions ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''");
      this.db.exec("UPDATE acp_sessions SET updated_at = created_at WHERE updated_at = ''");
    }
  }

  create(record: Omit<SessionRecord, 'sessionId' | 'threadId' | 'createdAt' | 'updatedAt'>): SessionRecord {
    const now = new Date().toISOString();
    const full: SessionRecord = {
      ...record,
      sessionId: randomUUID().replace(/-/g, ''),
      threadId: randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        'INSERT INTO acp_sessions (session_id, thread_id, model_value, mode_id, title, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(full.sessionId, full.threadId, full.modelValue, full.modeId, full.title, full.cwd, full.createdAt, full.updatedAt);
    return full;
  }

  get(sessionId: string): SessionRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM acp_sessions WHERE session_id = ?')
      .get(sessionId) as SessionRow | undefined;
    return row ? rowToRecord(row) : undefined;
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
    // 配置变更是会话活动:连带刷新 updated_at。
    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    this.db
      .prepare(`UPDATE acp_sessions SET ${sets.join(', ')} WHERE session_id = ?`)
      .run(...values, sessionId);
  }

  /** 刷新会话活跃时间(prompt/resume)。 */
  touch(sessionId: string): void {
    this.db
      .prepare('UPDATE acp_sessions SET updated_at = ? WHERE session_id = ?')
      .run(new Date().toISOString(), sessionId);
  }

  /** 列出会话,按 updated_at 倒序(最新活跃在前);createdAt 作并列时的稳定次序。 */
  list(query: ListSessionsQuery = {}): SessionRecord[] {
    const where = query.cwd !== undefined ? 'WHERE cwd = ?' : '';
    const limit = query.limit !== undefined ? `LIMIT ${Math.trunc(query.limit)}` : '';
    const offset = query.offset ? `OFFSET ${Math.trunc(query.offset)}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM acp_sessions ${where} ORDER BY updated_at DESC, created_at DESC, session_id DESC ${limit} ${offset}`)
      .all(...(query.cwd !== undefined ? [query.cwd] : [])) as SessionRow[];
    return rows.map(rowToRecord);
  }

  /** 删除会话元数据行;返回是否真的删了(不存在时 false)。 */
  delete(sessionId: string): boolean {
    const result = this.db.prepare('DELETE FROM acp_sessions WHERE session_id = ?').run(sessionId);
    return Number(result.changes) > 0;
  }
}

function rowToRecord(row: SessionRow): SessionRecord {
  return {
    sessionId: row.session_id,
    threadId: row.thread_id,
    modelValue: row.model_value,
    modeId: row.mode_id,
    title: row.title,
    cwd: row.cwd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
