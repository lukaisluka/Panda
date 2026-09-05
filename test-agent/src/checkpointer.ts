/**
 * SQLite 落盘的 LangGraph checkpointer:会话线程状态跨连接、跨进程重启持久化。
 *
 * 每条 WebSocket 连接对应一个 stdio 子进程(见 serve.ts),进程内存里的
 * checkpointer 无法支撑 reconnect 后的 session/load,必须落盘。实现语义
 * 对齐官方 MemorySaver(同一套 serde 编解码与 tuple 形状),只是把两层
 * Map 换成 SQLite 表——node:sqlite 内置,无原生编译依赖。
 *
 * 写入按(线程, checkpoint)全量 upsert,不做增量;测试 agent 的对话量
 * 下这个开销可忽略,换来的是崩溃后状态文件永远自洽。
 */

import { DatabaseSync } from 'node:sqlite';
import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite,
} from '@langchain/langgraph-checkpoint';
import type { RunnableConfig } from '@langchain/core/runnables';

export class SqliteCheckpointSaver extends BaseCheckpointSaver {
  /** 共享给同库的 SessionStore:同一文件只开一条连接。 */
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    super();
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL,
        checkpoint BLOB NOT NULL,
        metadata BLOB NOT NULL,
        parent_checkpoint_id TEXT,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      );
      CREATE TABLE IF NOT EXISTS checkpoint_writes (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        idx TEXT NOT NULL,
        value BLOB NOT NULL,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  private async tupleFromRow(
    row: { thread_id: string; checkpoint_ns: string; checkpoint_id: string; checkpoint: Uint8Array; metadata: Uint8Array; parent_checkpoint_id: string | null },
    config: RunnableConfig | undefined,
  ): Promise<CheckpointTuple> {
    const checkpoint = (await this.serde.loadsTyped('json', row.checkpoint)) as Checkpoint;
    const metadata = (await this.serde.loadsTyped('json', row.metadata)) as CheckpointMetadata;
    const pendingWrites = await this.loadWrites(row.thread_id, row.checkpoint_ns, row.checkpoint_id);
    const tuple: CheckpointTuple = {
      config: config ?? {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: row.checkpoint_ns,
          checkpoint_id: row.checkpoint_id,
        },
      },
      checkpoint,
      metadata,
      pendingWrites,
    };
    if (row.parent_checkpoint_id !== null) {
      tuple.parentConfig = {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: row.checkpoint_ns,
          checkpoint_id: row.parent_checkpoint_id,
        },
      };
    }
    return tuple;
  }

  private async loadWrites(threadId: string, ns: string, checkpointId: string): Promise<CheckpointPendingWrite[]> {
    const rows = this.db
      .prepare(
        'SELECT task_id, channel, value FROM checkpoint_writes WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?',
      )
      .all(threadId, ns, checkpointId) as { task_id: string; channel: string; value: Uint8Array }[];
    return Promise.all(
      rows.map(async (row) => [row.task_id, row.channel, await this.serde.loadsTyped('json', row.value)] as CheckpointPendingWrite),
    );
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const configurable = config.configurable ?? {};
    const threadId = configurable.thread_id as string | undefined;
    if (threadId === undefined) {
      return undefined;
    }
    const ns = (configurable.checkpoint_ns as string | undefined) ?? '';
    const checkpointId =
      (configurable.checkpoint_id as string | undefined) || (configurable.thread_ts as string | undefined) || '';
    if (checkpointId) {
      const row = this.db
        .prepare(
          'SELECT thread_id, checkpoint_ns, checkpoint_id, checkpoint, metadata, parent_checkpoint_id FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?',
        )
        .get(threadId, ns, checkpointId) as
        | { thread_id: string; checkpoint_ns: string; checkpoint_id: string; checkpoint: Uint8Array; metadata: Uint8Array; parent_checkpoint_id: string | null }
        | undefined;
      if (row) {
        return this.tupleFromRow(row, config);
      }
      return undefined;
    }
    const row = this.db
      .prepare(
        'SELECT thread_id, checkpoint_ns, checkpoint_id, checkpoint, metadata, parent_checkpoint_id FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? ORDER BY checkpoint_id DESC LIMIT 1',
      )
      .get(threadId, ns) as
      | { thread_id: string; checkpoint_ns: string; checkpoint_id: string; checkpoint: Uint8Array; metadata: Uint8Array; parent_checkpoint_id: string | null }
      | undefined;
    return row ? this.tupleFromRow(row, config) : undefined;
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    let { before, limit, filter } = options ?? {};
    const configurable = config.configurable ?? {};
    const threadIds: string[] = [];
    if (configurable.thread_id !== undefined) {
      threadIds.push(configurable.thread_id as string);
    } else {
      for (const row of this.db.prepare('SELECT DISTINCT thread_id FROM checkpoints').all() as { thread_id: string }[]) {
        threadIds.push(row.thread_id);
      }
    }
    const ns = configurable.checkpoint_ns as string | undefined;
    const checkpointId = configurable.checkpoint_id as string | undefined;
    const beforeId = before?.configurable?.checkpoint_id as string | undefined;

    for (const threadId of threadIds) {
      const rows = this.db
        .prepare(
          'SELECT thread_id, checkpoint_ns, checkpoint_id, checkpoint, metadata, parent_checkpoint_id FROM checkpoints WHERE thread_id = ? ORDER BY checkpoint_id DESC',
        )
        .all(threadId) as {
        thread_id: string;
        checkpoint_ns: string;
        checkpoint_id: string;
        checkpoint: Uint8Array;
        metadata: Uint8Array;
        parent_checkpoint_id: string | null;
      }[];
      for (const row of rows) {
        if (ns !== undefined && row.checkpoint_ns !== ns) continue;
        if (checkpointId && row.checkpoint_id !== checkpointId) continue;
        if (beforeId && row.checkpoint_id >= beforeId) continue;
        const metadata = (await this.serde.loadsTyped('json', row.metadata)) as CheckpointMetadata;
        if (filter && !Object.entries(filter).every(([key, value]) => (metadata as Record<string, unknown>)[key] === value)) continue;
        if (limit !== undefined) {
          if (limit <= 0) break;
          limit -= 1;
        }
        yield this.tupleFromRow(row, undefined);
      }
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: Record<string, number | string>,
  ): Promise<RunnableConfig> {
    const configurable = config.configurable ?? {};
    const threadId = configurable.thread_id as string | undefined;
    if (threadId === undefined) {
      throw new Error(
        'Failed to put checkpoint. The passed RunnableConfig is missing a required "thread_id" field in its "configurable" property.',
      );
    }
    const ns = (configurable.checkpoint_ns as string | undefined) ?? '';
    const parentId = configurable.checkpoint_id as string | undefined;
    // dumpsTyped 返回 [type, bytes];checkpointer 协议固定 json 编码
    const [, checkpointBytes] = await this.serde.dumpsTyped(checkpoint);
    const [, metadataBytes] = await this.serde.dumpsTyped(metadata);
    this.db
      .prepare(
        `INSERT INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, checkpoint, metadata, parent_checkpoint_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id) DO UPDATE SET
           checkpoint = excluded.checkpoint, metadata = excluded.metadata, parent_checkpoint_id = excluded.parent_checkpoint_id`,
      )
      .run(threadId, ns, checkpoint.id, checkpointBytes, metadataBytes, parentId ?? null);
    return {
      configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: checkpoint.id },
    };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const configurable = config.configurable ?? {};
    const threadId = configurable.thread_id as string | undefined;
    const checkpointId = configurable.checkpoint_id as string | undefined;
    if (threadId === undefined) {
      throw new Error('Failed to put writes. The passed RunnableConfig is missing a required "thread_id".');
    }
    if (checkpointId === undefined) {
      throw new Error('Failed to put writes. The passed RunnableConfig is missing a required "checkpoint_id".');
    }
    const ns = (configurable.checkpoint_ns as string | undefined) ?? '';
    const insert = this.db.prepare(
      `INSERT INTO checkpoint_writes (thread_id, checkpoint_ns, checkpoint_id, task_id, channel, idx, value)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id, task_id, idx) DO UPDATE SET value = excluded.value`,
    );
    for (const [i, [channel, value]] of writes.entries()) {
      const [, valueBytes] = await this.serde.dumpsTyped(value);
      // 特殊通道(错误/中断/恢复)映射为负 idx,与 MemorySaver 的去重语义一致:
      // 同一 task 的常规写按原始序号,重复 put 时 upsert 覆盖。
      const specialIdx = (WRITES_IDX_MAP as Record<string, number>)[channel];
      const idx = specialIdx !== undefined ? String(specialIdx) : String(i);
      insert.run(threadId, ns, checkpointId, taskId, channel, idx, valueBytes);
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    this.db.prepare('DELETE FROM checkpoints WHERE thread_id = ?').run(threadId);
    this.db.prepare('DELETE FROM checkpoint_writes WHERE thread_id = ?').run(threadId);
  }
}
