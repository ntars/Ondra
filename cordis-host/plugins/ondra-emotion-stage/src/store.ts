/**
 * 关系状态的持久化面：一张单行表。
 *
 * ## 为什么是单行
 *
 * 与 O-026 同一条理由：关系是一个整体，存成「一个维度一行」会让一次结算变成 N 次写，
 * 中途崩一次就得到「好感是新的、信任是旧的」这种自相矛盾的存档。
 * 而且四维之间要做一致性判定（病态阶要求 trust ≤ 0.55），
 * 不同时刻的值放在一起比，比出来的结论没有意义。
 *
 * ## 为什么把「阶段」和「关系值」放同一行
 *
 * 它们必须一起提交。分两张表时，会出现「升阶成功、关系值写失败」的中间态：
 * 阶段是落定、好感还是 0.2，而下一次判定会因为「只升不降」永远修不回来。
 * 一行一次 upsert，要么都成、要么都不成。
 *
 * ## 读失败按「全新关系」处理
 *
 * 读不出来时若抛错，整个插件起不来；若当成「全新关系」，最坏是回到敌意阶重走一遍。
 * 两害相权取后者——关系可以重走，插件不能装不上。
 */

import type { ColumnSpecLike, LogLike, RowLike, StoreLike, TableSpecLike } from './types.js'

/** 状态表名。 */
export const TABLE_RELATION = 'emotion_relation_state'

/** 单行表的主键。永远只有这一行。 */
const SINGLETON_ID = 'singleton'

/**
 * 列声明。
 *
 * 显式标成 `readonly ColumnSpecLike[]`：多组形状不同的对象字面量放一个数组里，
 * 推断会把 `type` 拓宽成 `string`，整个表声明就不再满足 `TableSpecLike`。
 */
const RELATION_COLUMNS: readonly ColumnSpecLike[] = Object.freeze([
  { name: 'id', type: 'TEXT', notNull: true, primaryKey: true },
  { name: 'affection', type: 'REAL', notNull: true },
  { name: 'trust', type: 'REAL', notNull: true },
  { name: 'intimacy', type: 'REAL', notNull: true },
  { name: 'interactions', type: 'INTEGER', notNull: true, default: '0' },
  { name: 'first_met_at', type: 'INTEGER', notNull: true },
  { name: 'stage', type: 'TEXT', notNull: true },
  { name: 'stage_entered_at', type: 'INTEGER', notNull: true },
  { name: 'sacrifice', type: 'INTEGER', notNull: true, default: '0' },
  { name: 'settled_at', type: 'INTEGER', notNull: true },
  { name: 'updated_at', type: 'INTEGER', notNull: true },
])

/** 表结构。 */
const RELATION_TABLE: TableSpecLike = Object.freeze({
  name: TABLE_RELATION,
  columns: RELATION_COLUMNS,
  strict: true,
})

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 一行存档的**原始形态**（解析交给上层，因为解析要按基线兜底）。 */
export interface RawRelationRow {
  /** 好感。 */
  readonly affection: number
  /** 信任。 */
  readonly trust: number
  /** 亲密。 */
  readonly intimacy: number
  /** 累计互动。 */
  readonly interactions: number
  /** 首次相遇时刻。 */
  readonly firstMetAt: number
  /** 阶段名（可能是脏数据）。 */
  readonly stage: string
  /** 进入该阶的时刻。 */
  readonly stageEnteredAt: number
  /** `sacrifice` 标记。 */
  readonly sacrifice: boolean
  /** 上次结算时刻。 */
  readonly settledAt: number
  /** 上次写入时刻。 */
  readonly updatedAt: number
}

/** 要写入的一行。 */
export interface RelationWrite extends RawRelationRow {}

/** 状态仓库。 */
export class RelationStore {
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

  /** 后端标识，给 `stats()` 用。 */
  get provider(): string {
    return this.store.provider
  }

  /**
   * 建表。失败**不抛**：没有存档时关系只活在内存里，重启回到敌意阶。
   * @returns 是否可用。
   */
  ensure(): boolean {
    try {
      const result = this.store.ensureTable(RELATION_TABLE)
      for (const issue of result.issues) {
        this.log.warn('关系状态表有问题（%s）：%s', issue.code, issue.detail)
      }
      return true
    } catch (error) {
      this.log.warn('建关系状态表失败，本次运行不落盘：%s', messageOf(error))
      return false
    }
  }

  /**
   * 读存档。
   * @returns 原始行；没有存档或读失败时为 `undefined`。
   */
  load(): RawRelationRow | undefined {
    try {
      const rows: RowLike[] = this.store.select(TABLE_RELATION, {
        where: [{ column: 'id', op: 'eq', value: SINGLETON_ID }],
        limit: 1,
      })
      const row: RowLike | undefined = rows[0]
      if (row === undefined) return undefined
      return {
        affection: Number(row['affection'] ?? 0),
        trust: Number(row['trust'] ?? 0),
        intimacy: Number(row['intimacy'] ?? 0),
        interactions: Number(row['interactions'] ?? 0),
        firstMetAt: Number(row['first_met_at'] ?? 0),
        stage: String(row['stage'] ?? ''),
        stageEnteredAt: Number(row['stage_entered_at'] ?? 0),
        sacrifice: Number(row['sacrifice'] ?? 0) === 1,
        settledAt: Number(row['settled_at'] ?? 0),
        updatedAt: Number(row['updated_at'] ?? 0),
      }
    } catch (error) {
      this.log.warn('读关系存档失败，按「全新关系」处理：%s', messageOf(error))
      return undefined
    }
  }

  /**
   * 写存档。
   * @param write 要写的一行。
   * @returns 是否成功。
   */
  save(write: RelationWrite): boolean {
    const row: RowLike = {
      id: SINGLETON_ID,
      affection: write.affection,
      trust: write.trust,
      intimacy: write.intimacy,
      interactions: Math.trunc(write.interactions),
      first_met_at: Math.trunc(write.firstMetAt),
      stage: write.stage,
      stage_entered_at: Math.trunc(write.stageEnteredAt),
      sacrifice: write.sacrifice ? 1 : 0,
      settled_at: Math.trunc(write.settledAt),
      updated_at: Math.trunc(write.updatedAt),
    }
    try {
      // upsert 而不是 insert：单行表第二次保存时主键已存在。
      this.store.upsert(TABLE_RELATION, row)
      return true
    } catch (error) {
      this.log.warn('写关系存档失败（下次再试）：%s', messageOf(error))
      return false
    }
  }
}
