/**
 * 钉子表的读写（**只走表级 CRUD，不用 `raw`**）。
 *
 * 理由与其余记忆插件一致：必须两个后端都能跑（SQLite 与内存兜底），
 * 一旦用上自定义 SQL，内存后端立刻失效——而它存在的理由正是「SQLite 打不开」。
 *
 * 钉子表只有三列，故不做通用化封装：多一层抽象换来的「灵活性」在这里没有用处。
 */

import { TABLE_PIN } from './types.js'
import type { LogLike, PinRecord, RowLike, StoreLike } from './types.js'
import { TABLE_PIN_SPEC } from './schema.js'

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

/**
 * 行 → 钉子。
 * @param row 数据行。
 */
export function toPin(row: RowLike): PinRecord {
  return {
    id: textOf(row['id']),
    pinnedAt: numberOf(row['pinned_at'], 0),
    note: textOf(row['note']),
  }
}

/**
 * 钉子 → 行。
 * @param record 钉子。
 */
export function pinToRow(record: PinRecord): RowLike {
  return { id: record.id, pinned_at: record.pinnedAt, note: record.note }
}

/** 钉子仓库。 */
export class PinStore {
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
   * 建表（幂等）。失败只记日志，不抛——建表失败会让服务转 `available=false`，
   * 但那由服务层判断，不该在这里炸掉宿主。
   * @returns 是否可用。
   */
  ensure(): boolean {
    if (this.ensured) return true
    try {
      const result = this.store.ensureTable(TABLE_PIN_SPEC)
      if (result.issues.length > 0) {
        for (const issue of result.issues) {
          this.log.warn('钉子表结构告警（%s / %s）：%s', issue.code, issue.table, issue.detail)
        }
      }
      this.ensured = true
      return true
    } catch (error) {
      this.log.error('建钉子表失败：%s', messageOf(error))
      return false
    }
  }

  /**
   * 按 id 取。
   * @param id 记忆 id。
   */
  get(id: string): PinRecord | undefined {
    try {
      const row = this.store.get(TABLE_PIN, { id })
      return row === undefined ? undefined : toPin(row)
    } catch (error) {
      this.log.warn('读钉子失败（%s）：%s', id, messageOf(error))
      return undefined
    }
  }

  /**
   * 覆盖写（同一条记忆重复钉 = 刷新时间与备注，不产生第二行）。
   * @param record 钉子。
   */
  put(record: PinRecord): void {
    this.store.upsert(TABLE_PIN, pinToRow(record))
  }

  /**
   * 删一根钉子。
   * @param id 记忆 id。
   */
  remove(id: string): number {
    try {
      return this.store.delete(TABLE_PIN, { id })
    } catch (error) {
      this.log.warn('拔钉失败（%s）：%s', id, messageOf(error))
      return 0
    }
  }

  /** 全部钉子（按钉住时间正序：注入块 ② 的顺序不该随写入顺序乱跳）。 */
  all(): PinRecord[] {
    try {
      return this.store
        .select(TABLE_PIN, { orderBy: [{ column: 'pinned_at', direction: 'asc' }] })
        .map(toPin)
    } catch (error) {
      this.log.warn('读钉子列表失败：%s', messageOf(error))
      return []
    }
  }

  /** 钉子条数。 */
  count(): number {
    try {
      return this.store.count(TABLE_PIN)
    } catch (error) {
      this.log.warn('数钉子失败：%s', messageOf(error))
      return 0
    }
  }

  /** 后端标识。 */
  get provider(): string {
    return this.store.provider
  }
}
