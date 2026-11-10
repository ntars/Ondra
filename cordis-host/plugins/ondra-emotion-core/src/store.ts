/**
 * 情绪状态的持久化面：一张单行表。
 *
 * ## 为什么是一张单行表，而不是「每个激素一行」
 *
 * 每个激素一行，看起来更像「数据库」，但会带来一个坏结果：
 * **一次情绪的保存变成 N 次写**，中途崩一次就得到半池子数据——
 * 皮质醇是新的、血清素是旧的，两个值来自不同时刻，谁也不对。
 * 情绪是一个整体，存成一行才有一致性。
 *
 * ## 为什么状态列用 JSON 文本
 *
 * 六维（6）+ 标签（10）+ 激素（3–15，动态上限 12），展开是 19–31 列，
 * 而且**动态激素数量是可变的**——列数随运行时变化，那就不是 schema 了。
 * JSON 列在这里不是偷懒，是唯一不需要迁移的做法。
 *
 * 代价是「按激素查询」变难。但本插件从来不需要「查出所有皮质醇 > 70 的行」——
 * 那种查询是面板的事（应用侧），它读的是服务快照，不是数据库。
 *
 * ## 为什么时间存毫秒整数
 *
 * 与 O-010 同口径。跨时区比较不会退化成字典序。
 */

import type { ColumnSpecLike, LogLike, RowLike, StoreLike, TableSpecLike } from './types.js'

/** 状态表名。 */
export const TABLE_STATE = 'emotion_state'

/** 单行表的主键。永远只有这一行。 */
const SINGLETON_ID = 'singleton'

/**
 * 列声明。
 *
 * 显式标成 `readonly ColumnSpecLike[]`，而不是靠 `Object.freeze` 推断：
 * 三组形状不同的对象字面量放在一个数组里，推断会把 `type` 拓宽成 `string`，
 * 于是整个表声明不再满足 `TableSpecLike`——错误信息还会指向 `Object.freeze` 那一行，
 * 看起来像是冻结有问题。
 */
const STATE_COLUMNS: readonly ColumnSpecLike[] = Object.freeze([
  { name: 'id', type: 'TEXT', notNull: true, primaryKey: true },
  { name: 'axes', type: 'TEXT', notNull: true },
  { name: 'labels', type: 'TEXT', notNull: true },
  { name: 'hormones', type: 'TEXT', notNull: true },
  /*
   * `default` 必须是**带单引号的 SQL 字面量**，不是 TypeScript 字符串值。
   *
   * 这一列初版写成 `default: '[]'`，渲染出 `DEFAULT []`——那不是字面量而是
   * 一个数组语法，`ondra-store-sqlite` 的 `assertDefault()` 直接拒绝，
   * `ensureTable()` 抛错，`StateStore.ensure()` 返回 false，
   * 于是 `emotion-core` 整个跑在内存态（`reason = 'schema-failed'`）：
   * 服务在、`available` 为 true、六态照常判「平静」，**只有重启会丢情绪**。
   * 这种「降级不报错」的形态能一直活到有人去查 `stats().reason`。
   *
   * 保留这个默认值是为了补列：`ALTER TABLE ADD COLUMN` 加 `NOT NULL` 必须带默认。
   */
  { name: 'dynamic', type: 'TEXT', notNull: true, default: "'[]'" },
  { name: 'temperament', type: 'TEXT', notNull: true },
  { name: 'settled_at', type: 'INTEGER', notNull: true },
  { name: 'updated_at', type: 'INTEGER', notNull: true },
])

/** 表结构。 */
const STATE_TABLE: TableSpecLike = Object.freeze({
  name: TABLE_STATE,
  columns: STATE_COLUMNS,
  strict: true,
})

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 一行存档的**原始文本**（解析交给上层，因为解析要用气质的现行值兜底）。 */
export interface RawStateRow {
  /** 六维 JSON。 */
  readonly axes: string
  /** 标签 JSON。 */
  readonly labels: string
  /** 激素 JSON。 */
  readonly hormones: string
  /** 动态激素名单 JSON。 */
  readonly dynamic: string
  /** 气质 JSON。 */
  readonly temperament: string
  /** 上次结算时刻。 */
  readonly settledAt: number
  /** 上次写入时刻。 */
  readonly updatedAt: number
}

/** 要写入的一行。 */
export interface StateWrite {
  /** 六维。 */
  readonly axes: unknown
  /** 标签。 */
  readonly labels: unknown
  /** 激素。 */
  readonly hormones: unknown
  /** 动态激素名单。 */
  readonly dynamic: unknown
  /** 气质。 */
  readonly temperament: unknown
  /** 结算时刻。 */
  readonly settledAt: number
  /** 写入时刻。 */
  readonly updatedAt: number
}

/** 状态仓库。 */
export class StateStore {
  private readonly store: StoreLike
  private readonly log: LogLike

  /**
   * @param store 存储端口。
   * @param log 日志。
   */
  constructor(store: StoreLike, log: LogLike) {
    this.store = store
    this.log = log
  }

  /**
   * 建表。
   *
   * 建表失败**不抛**：情绪内核在没有存档的情况下仍然能跑（纯内存），
   * 只是重启归零。抛出去会让整个插件停在失败态，那比「丢存档」严重得多。
   * @returns 是否可用。
   */
  ensure(): boolean {
    try {
      const result = this.store.ensureTable(STATE_TABLE)
      for (const issue of result.issues) {
        this.log.warn('情绪状态表有问题（%s）：%s', issue.code, issue.detail)
      }
      return true
    } catch (error) {
      this.log.warn('建情绪状态表失败，本次运行不落盘：%s', messageOf(error))
      return false
    }
  }

  /**
   * 读存档。
   * @returns 原始行；没有存档或读失败时为 `undefined`。
   */
  load(): RawStateRow | undefined {
    try {
      const rows = this.store.select(TABLE_STATE, {
        where: [{ column: 'id', op: 'eq', value: SINGLETON_ID }],
        limit: 1,
      })
      const row = rows[0]
      if (row === undefined) return undefined
      return {
        axes: String(row['axes'] ?? '{}'),
        labels: String(row['labels'] ?? '{}'),
        hormones: String(row['hormones'] ?? '{}'),
        dynamic: String(row['dynamic'] ?? '[]'),
        temperament: String(row['temperament'] ?? '{}'),
        settledAt: Number(row['settled_at'] ?? 0),
        updatedAt: Number(row['updated_at'] ?? 0),
      }
    } catch (error) {
      this.log.warn('读情绪存档失败，按「没有存档」处理：%s', messageOf(error))
      return undefined
    }
  }

  /**
   * 写存档。
   * @param write 要写的一行。
   * @returns 是否成功。
   */
  save(write: StateWrite): boolean {
    const row: RowLike = {
      id: SINGLETON_ID,
      axes: JSON.stringify(write.axes),
      labels: JSON.stringify(write.labels),
      hormones: JSON.stringify(write.hormones),
      dynamic: JSON.stringify(write.dynamic),
      temperament: JSON.stringify(write.temperament),
      settled_at: Math.trunc(write.settledAt),
      updated_at: Math.trunc(write.updatedAt),
    }
    try {
      // 用 upsert 而不是 insert：单行表第二次保存时主键已存在。
      this.store.upsert(TABLE_STATE, row)
      return true
    } catch (error) {
      this.log.warn('写情绪存档失败（下次再试）：%s', messageOf(error))
      return false
    }
  }

  /** 存档是否存在。 */
  exists(): boolean {
    try {
      return this.store.count(TABLE_STATE, [{ column: 'id', op: 'eq', value: SINGLETON_ID }]) > 0
    } catch {
      return false
    }
  }
}

/**
 * 安全地解析一段 JSON。
 *
 * 坏掉的 JSON **不抛**：抛出去会让「一个字段坏了」升级成「整份存档读不了」。
 * @param text 原始文本。
 * @param fallback 解析失败时的返回值。
 */
export function parseJson(text: string, fallback: unknown): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return fallback
  }
}
