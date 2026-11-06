/**
 * 两张表的读写（**只走表级 CRUD，不用 `raw`**）。
 *
 * 为什么不用原始 SQL：本插件必须两个后端都能跑（SQLite 与内存兜底），
 * 一旦用上自定义 SQL，内存后端立刻失效——而「SQLite 打不开」正是内存后端
 * 存在的理由。代价是没有聚合查询，故 `stats()` 用 `count()` 逐项算。
 *
 * 行 ↔ 对象的转换集中在一个地方（`toPromise` / `toRow` 这一对）：
 * 分散转换会让「`state` 存成大写」「`done` 存成 `'true'`」这类问题在某一处悄悄出错。
 * 存储端口给回来的值类型不保证（SQLite 给数字、内存后端可能给布尔），
 * 故一律走 `numberOf` / `textOf` / `boolOf` 收口。
 */

import { TABLE_PROMISE, TABLE_TODO } from './types.js'
import type {
  FilterLike,
  LogLike,
  PromiseRecord,
  PromiseState,
  RowLike,
  SelectQueryLike,
  StoreLike,
  TodoRecord,
} from './types.js'
import { TABLE_PROMISE_SPEC, TABLE_TODO_SPEC } from './schema.js'

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 收口数字。 */
function numberOf(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return fallback
}

/** 收口字符串。 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 收口布尔（0/1、'0'/'1'、true/false 都认）。 */
function boolOf(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true'
  return false
}

/** 收口承诺状态：认不出的值一律当 `open`（宁可多提醒一次，不可静默丢一条）。 */
function stateOf(value: unknown): PromiseState {
  const text = textOf(value)
  if (text === 'kept' || text === 'broken' || text === 'expired') return text
  return 'open'
}

/**
 * 行 → 承诺。
 * @param row 数据行。
 */
export function toPromise(row: RowLike): PromiseRecord {
  return {
    id: textOf(row['id']),
    factId: textOf(row['fact_id']),
    text: textOf(row['text']),
    dueAt: numberOf(row['due_at'], 0),
    remindAt: numberOf(row['remind_at'], 0),
    graceUntil: numberOf(row['grace_until'], 0),
    state: stateOf(row['state']),
    createdAt: numberOf(row['created_at'], 0),
    settledAt: numberOf(row['settled_at'], 0),
    remindedAt: numberOf(row['reminded_at'], 0),
    timeWord: textOf(row['time_word']),
  }
}

/**
 * 承诺 → 行。
 * @param record 承诺。
 */
export function promiseToRow(record: PromiseRecord): RowLike {
  return {
    id: record.id,
    fact_id: record.factId,
    text: record.text,
    due_at: record.dueAt,
    remind_at: record.remindAt,
    grace_until: record.graceUntil,
    state: record.state,
    created_at: record.createdAt,
    settled_at: record.settledAt,
    reminded_at: record.remindedAt,
    time_word: record.timeWord,
  }
}

/**
 * 行 → 待办。
 * @param row 数据行。
 */
export function toTodo(row: RowLike): TodoRecord {
  return {
    id: textOf(row['id']),
    text: textOf(row['text']),
    createdAt: numberOf(row['created_at'], 0),
    lastMentionedAt: numberOf(row['last_mentioned_at'], 0),
    expiresAt: numberOf(row['expires_at'], 0),
    done: boolOf(row['done']),
  }
}

/**
 * 待办 → 行（布尔一律存 0/1：SQLite 没有布尔类型，存 `true` 会变成字符串 `'true'`，
 * 而 `where done = 0` 就再也查不到它）。
 * @param record 待办。
 */
export function todoToRow(record: TodoRecord): RowLike {
  return {
    id: record.id,
    text: record.text,
    created_at: record.createdAt,
    last_mentioned_at: record.lastMentionedAt,
    expires_at: record.expiresAt,
    done: record.done ? 1 : 0,
  }
}

/** 承诺与待办的仓库。 */
export class ProspectiveStore {
  private readonly store: StoreLike
  private readonly log: LogLike
  private ensured = false

  /**
   * @param store 存储端口。
   * @param log 日志。
   */
  constructor(store: StoreLike, log: LogLike) {
    this.store = store
    this.log = log
  }

  /**
   * 建两张表（幂等）。失败只记日志，不抛——建表失败会让服务转 `available=false`，
   * 但那由服务层判断，不该在这里炸掉宿主。
   * @returns 是否两张表都就绪。
   */
  ensure(): boolean {
    if (this.ensured) return true
    let ok = true
    for (const spec of [TABLE_PROMISE_SPEC, TABLE_TODO_SPEC]) {
      try {
        const result = this.store.ensureTable(spec)
        if (result.issues.length > 0) {
          for (const issue of result.issues) {
            this.log.warn('表结构告警（%s / %s / %s）：%s', issue.code, issue.table, issue.column ?? '-', issue.detail)
          }
        }
      } catch (error) {
        this.log.error('建表 %s 失败：%s', spec.name, messageOf(error))
        ok = false
      }
    }
    this.ensured = ok
    return ok
  }

  /* ----------------------------- 承诺 ----------------------------- */

  /**
   * 按 id 取承诺。
   * @param id 主键。
   */
  getPromise(id: string): PromiseRecord | undefined {
    try {
      const row = this.store.get(TABLE_PROMISE, { id })
      return row === undefined ? undefined : toPromise(row)
    } catch (error) {
      this.log.warn('读承诺失败（%s）：%s', id, messageOf(error))
      return undefined
    }
  }

  /**
   * 覆盖写（主键 `p-<factId>` 是确定性的，故重放同一句话不会产生两条）。
   * @param record 承诺。
   */
  putPromise(record: PromiseRecord): void {
    this.store.upsert(TABLE_PROMISE, promiseToRow(record))
  }

  /**
   * 局部更新。
   * @param id 主键。
   * @param patch 要改的字段。
   */
  patchPromise(id: string, patch: Partial<PromiseRecord>): number {
    const row: RowLike = {}
    if (patch.dueAt !== undefined) row['due_at'] = patch.dueAt
    if (patch.remindAt !== undefined) row['remind_at'] = patch.remindAt
    if (patch.graceUntil !== undefined) row['grace_until'] = patch.graceUntil
    if (patch.state !== undefined) row['state'] = patch.state
    if (patch.settledAt !== undefined) row['settled_at'] = patch.settledAt
    if (patch.remindedAt !== undefined) row['reminded_at'] = patch.remindedAt
    if (Object.keys(row).length === 0) return 0
    return this.store.update(TABLE_PROMISE, { id }, row)
  }

  /**
   * 删一条承诺。
   * @param id 主键。
   */
  deletePromise(id: string): number {
    try {
      return this.store.delete(TABLE_PROMISE, { id })
    } catch (error) {
      this.log.warn('删承诺失败（%s）：%s', id, messageOf(error))
      return 0
    }
  }

  /**
   * 查承诺。
   * @param query 条件。
   */
  selectPromises(query?: SelectQueryLike): PromiseRecord[] {
    try {
      return this.store.select(TABLE_PROMISE, query).map(toPromise)
    } catch (error) {
      this.log.warn('查承诺失败：%s', messageOf(error))
      return []
    }
  }

  /**
   * 数承诺。
   * @param where 条件。
   */
  countPromises(where?: readonly FilterLike[]): number {
    try {
      return this.store.count(TABLE_PROMISE, where)
    } catch (error) {
      this.log.warn('数承诺失败：%s', messageOf(error))
      return 0
    }
  }

  /* ----------------------------- 待办 ----------------------------- */

  /**
   * 按 id 取待办。
   * @param id 主键。
   */
  getTodo(id: string): TodoRecord | undefined {
    try {
      const row = this.store.get(TABLE_TODO, { id })
      return row === undefined ? undefined : toTodo(row)
    } catch (error) {
      this.log.warn('读待办失败（%s）：%s', id, messageOf(error))
      return undefined
    }
  }

  /**
   * 插入待办（主键由调用方生成，不 upsert：待办的主键不是内容派生的，
   * 覆盖写会让两条不同的待办撞成一条）。
   * @param record 待办。
   */
  insertTodo(record: TodoRecord): void {
    this.store.insert(TABLE_TODO, todoToRow(record))
  }

  /**
   * 局部更新待办。
   * @param id 主键。
   * @param patch 要改的字段。
   */
  patchTodo(id: string, patch: Partial<TodoRecord>): number {
    const row: RowLike = {}
    if (patch.lastMentionedAt !== undefined) row['last_mentioned_at'] = patch.lastMentionedAt
    if (patch.expiresAt !== undefined) row['expires_at'] = patch.expiresAt
    if (patch.done !== undefined) row['done'] = patch.done ? 1 : 0
    if (Object.keys(row).length === 0) return 0
    return this.store.update(TABLE_TODO, { id }, row)
  }

  /**
   * 删一条待办。
   * @param id 主键。
   */
  deleteTodo(id: string): number {
    try {
      return this.store.delete(TABLE_TODO, { id })
    } catch (error) {
      this.log.warn('删待办失败（%s）：%s', id, messageOf(error))
      return 0
    }
  }

  /**
   * 查待办。
   * @param query 条件。
   */
  selectTodos(query?: SelectQueryLike): TodoRecord[] {
    try {
      return this.store.select(TABLE_TODO, query).map(toTodo)
    } catch (error) {
      this.log.warn('查待办失败：%s', messageOf(error))
      return []
    }
  }

  /**
   * 数待办。
   * @param where 条件。
   */
  countTodos(where?: readonly FilterLike[]): number {
    try {
      return this.store.count(TABLE_TODO, where)
    } catch (error) {
      this.log.warn('数待办失败：%s', messageOf(error))
      return 0
    }
  }

  /** 后端标识（写进 `stats()`，排查时第一眼要看的东西）。 */
  get provider(): string {
    return this.store.provider
  }
}
