/**
 * 两张表的结构声明（**只声明，不建表**；建表由存储端口的 `ensureTable()` 执行）。
 *
 * 为什么池归属单独一张表，而不是给 `memory_fact` 加一列：
 *
 * 1. **`memory_fact` 的表结构归 O-010。** 加列要同时改它的 schema、补 O-008 的迁移、
 *    同步所有消费方的 `MemoryRecord` 镜像——四个插件一起动，收益只是省一次查表，
 *    而端口没有 JOIN，这一次也省不掉。
 * 2. **池是「分类决定」，不是「记忆属性」。** 同一条记忆可以被人工改池（`reassign`），
 *    写进本体就把一次判定固化成数据事实，改池要改正文行。
 * 3. **`core` 上限的计数要能一条 SQL 之外的路径算清。** 单独一张表，
 *    `count({pool:'core'})` 就够；写进本体则要扫全表。
 *
 * **两张表都不建外键**：`fact_id` 指向 `memory_fact.id`，但记忆会被真删（`forget`）。
 * 外键级联在这里有害——它会让人以为「池登记一定和记忆同生共死」。实际上
 * `forget()` 之后若登记没被清掉（例如进程在两步之间崩了），我们**需要看见**
 * 这条孤儿登记并报出来，而不是让数据库悄悄替我们决定。
 */

import { TABLE_HINT, TABLE_POOL } from './types.js'
import type { TableSpecLike } from './types.js'

/**
 * 池归属表。
 *
 * `assigned_at` 是唯一的时间锚点吗？**不是。** 三段天级时间轴的锚点是
 * 「最近一次被带出」（`memory_fact.last_seen_at`，为 0 时退回 `created_at`），
 * 而不是分配时刻——否则一条三年前的核心事实会被当成「刚分配」重新计宽限。
 * `assigned_at` 只用于「这条是什么时候被归到这个池的」这类审计问题。
 */
export const TABLE_POOL_SPEC: TableSpecLike = Object.freeze({
  name: TABLE_POOL,
  columns: Object.freeze([
    // 主键就是记忆 id：一条记忆最多一个池，重复分配天然幂等（upsert）。
    { name: 'fact_id', type: 'TEXT', notNull: true, primaryKey: true },
    { name: 'pool', type: 'TEXT', notNull: true },
    { name: 'assigned_at', type: 'INTEGER', notNull: true },
    { name: 'source', type: 'TEXT', notNull: true },
    { name: 'unclassified', type: 'INTEGER', notNull: true, default: '0' },
    { name: 'matched_label', type: 'TEXT' },
    { name: 'note', type: 'TEXT', notNull: true, default: "''" },
  ]),
  indexes: Object.freeze([
    // 按池计数（core 上限判定、成长面板按池统计）都走这条。
    { name: 'idx_memory_pool_pool', columns: Object.freeze(['pool']) },
    { name: 'idx_memory_pool_assigned', columns: Object.freeze(['assigned_at']) },
  ]),
  strict: true,
} satisfies TableSpecLike)

/**
 * 「未归类」线索表。
 *
 * 手册 §2.5：「同一句重复写满 3 次 → 升级『需人工定池』」。
 * 这条线索必须**跨轮、跨会话累加**——只放内存的话，「写满 3 次」在重启后永远凑不够，
 * 于是那条记忆永远躺在海马体里没人管。
 *
 * 键用 `digest`（去空白后的 sha256 前 32 位，与 O-010 的 `digestOf` 同口径）：
 * 这样「同一句」的判定不靠字符串精确相等（多了个空格就变两条）。
 */
export const TABLE_HINT_SPEC: TableSpecLike = Object.freeze({
  name: TABLE_HINT,
  columns: Object.freeze([
    { name: 'digest', type: 'TEXT', notNull: true, primaryKey: true },
    { name: 'preview', type: 'TEXT', notNull: true, default: "''" },
    { name: 'attempts', type: 'INTEGER', notNull: true, default: '0' },
    { name: 'escalated', type: 'INTEGER', notNull: true, default: '0' },
    { name: 'first_at', type: 'INTEGER', notNull: true },
    { name: 'last_at', type: 'INTEGER', notNull: true },
  ]),
  indexes: Object.freeze([
    { name: 'idx_memory_pool_hint_escalated', columns: Object.freeze(['escalated', 'last_at']) },
  ]),
  strict: true,
} satisfies TableSpecLike)

/** 全部表声明。顺序即建表顺序（先归属后线索）。 */
export const POOL_TABLES: readonly TableSpecLike[] = Object.freeze([TABLE_POOL_SPEC, TABLE_HINT_SPEC])
