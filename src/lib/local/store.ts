/**
 * 本地存储的业务封装。
 *
 * `db.ts` 是裸的 KV（表名 + 主键 + JSON）。这一层给它加上**表语义**：
 * 会话、消息、记忆各有自己的形状，调用方不该自己拼主键、也不该记得
 * 「消息按会话分组」这件事。
 *
 * ## 表清单
 *
 * | 表 | 主键 | 内容 |
 * | --- | --- | --- |
 * | `emotion` | `state` | 六维 + 标签 + 气质 + 结算时刻 |
 * | `session` | 会话 id | 会话元数据（标题、开始时间） |
 * | `message` | 消息 id | 一条消息（role / content / 时间） |
 * | `memory` | 记忆 id | 一条记忆事实 |
 * | `config` | `current` | 模型配置（基址、模型名、密钥） |
 * | `prefs` | `current` | 界面偏好（主题、字号） |
 *
 * 消息不挂在会话下面：IndexedDB 的键是扁平字符串，嵌套要靠前缀编码，
 * 而「按会话取消息」用一次全表过滤就够了（单会话制，消息最多几千条）。
 */

import * as db from './db.ts'

/** 读一条。 */
export async function dbGet<T>(table: string, id: string): Promise<T | undefined> {
  return await db.get<T>(table, id)
}

/** 写一条。 */
export async function dbPut(table: string, id: string, value: unknown): Promise<void> {
  await db.put(table, id, value)
}

/** 删一条。 */
export async function dbRemove(table: string, id: string): Promise<void> {
  await db.remove(table, id)
}

/** 列一张表。 */
export async function dbList<T>(table: string): Promise<Array<{ id: string; value: T }>> {
  return await db.list<T>(table)
}

/** 清空一张表。 */
export async function dbClear(table: string): Promise<void> {
  await db.clearTable(table)
}

/** 清空整个库。 */
export async function dbClearAll(): Promise<void> {
  await db.clearAll()
}

/* ------------------------------------------------------------------ *
 * 会话与消息
 * ------------------------------------------------------------------ */

/** 一条消息。字段与桌面版 `SessionMessage` 对齐。 */
export interface LocalMessage {
  id: string
  role: 'user' | 'assistant'
  /** 纯文本内容。富文本渲染在界面侧做，这里只存原串。 */
  content: string
  /** 毫秒时间戳。 */
  at: number
}

/** 会话元数据。单会话制，但保留 id 让导出格式与桌面版一致。 */
export interface LocalSession {
  id: string
  title: string
  startedAt: number
}

/** 取（或建）当前会话。 */
export async function currentSession(): Promise<LocalSession> {
  const existing = await dbGet<LocalSession>('session', 'current')
  if (existing !== undefined) return existing
  const fresh: LocalSession = { id: 'local', title: '', startedAt: Date.now() }
  await dbPut('session', 'current', fresh)
  return fresh
}

/** 按时间升序列出全部消息。 */
export async function listMessages(): Promise<LocalMessage[]> {
  const rows = await dbList<LocalMessage>('message')
  return rows.map((row) => row.value).sort((left, right) => left.at - right.at)
}

/** 追加一条消息。 */
export async function appendMessage(message: LocalMessage): Promise<void> {
  await dbPut('message', message.id, message)
}

/** 删一条消息。 */
export async function deleteMessage(id: string): Promise<void> {
  await dbRemove('message', id)
}

/** 清空全部消息。 */
export async function clearMessages(): Promise<void> {
  await dbClear('message')
}

/** 生成一个本地 id。不追求全局唯一，只要同一台设备上不撞。 */
export function localId(prefix: string): string {
  return `${prefix}-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`
}